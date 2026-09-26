const crypto = require("crypto");

const DEFAULT_SUBSCRIPTION_TTL_MS = 60000;
const DEFAULT_MAX_QUEUE = 512;

class EventSubscriptionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "EventSubscriptionError";
        this.code = code;
    }
}

function normalizeTimestamp(value, nowMs) {
    if (value === undefined || value === null) {
        return new Date(nowMs).toISOString();
    }

    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new Error("event.utcTime must be a valid date/time");
    }

    return date.toISOString();
}

function normalizeMessageLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("messageLimit must be a positive integer");
    }
    return parsed;
}

function normalizeTtl(value, fallback) {
    const parsed = value === undefined || value === null ? fallback : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("subscription ttlMs must be a positive number");
    }
    return Math.floor(parsed);
}

function stableObjectKey(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return JSON.stringify(value ?? null);
    }

    return JSON.stringify(
        Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, item])
        )
    );
}

function retainedEventKey(event) {
    if (event.key) {
        return String(event.key);
    }

    return `${event.topic}|${stableObjectKey(event.source || {})}`;
}

class EventBus {
    constructor(options = {}) {
        this.now = options.now || (() => Date.now());
        this.defaultTtlMs = normalizeTtl(
            options.defaultTtlMs,
            DEFAULT_SUBSCRIPTION_TTL_MS
        );
        this.maxQueue = Number.isInteger(options.maxQueue) && options.maxQueue > 0
            ? options.maxQueue
            : DEFAULT_MAX_QUEUE;

        this.sequence = 0;
        this.subscriptions = new Map();
        this.retained = new Map();
        this.topicRegistry = new Set(options.topics || []);
    }

    registerTopic(topic) {
        if (typeof topic !== "string" || topic.trim() === "") {
            throw new Error("topic must be a non-empty string");
        }

        this.topicRegistry.add(topic.trim());
    }

    getTopics() {
        return Array.from(this.topicRegistry).sort();
    }

    createSubscription(options = {}) {
        this.pruneExpired();

        const nowMs = this.now();
        const ttlMs = normalizeTtl(options.ttlMs, this.defaultTtlMs);
        const id = options.id || crypto.randomUUID();
        const topics = options.topics
            ? new Set(Array.from(options.topics, (topic) => String(topic)))
            : null;

        if (this.subscriptions.has(id)) {
            throw new EventSubscriptionError(
                "duplicate-subscription",
                `subscription already exists: ${id}`
            );
        }

        const subscription = {
            id,
            createdAt: nowMs,
            expiresAt: nowMs + ttlMs,
            topics,
            queue: [],
            waiter: null
        };

        this.subscriptions.set(id, subscription);

        return this.describeSubscription(subscription);
    }

    describeSubscription(subscription) {
        return {
            id: subscription.id,
            createdAt: new Date(subscription.createdAt).toISOString(),
            expiresAt: new Date(subscription.expiresAt).toISOString(),
            topics: subscription.topics ? Array.from(subscription.topics).sort() : null,
            queued: subscription.queue.length
        };
    }

    requireSubscription(id) {
        this.pruneExpired();

        const subscription = this.subscriptions.get(id);
        if (!subscription) {
            throw new EventSubscriptionError(
                "resource-unknown",
                `unknown or expired subscription: ${id}`
            );
        }

        return subscription;
    }

    renew(id, ttlMs) {
        const subscription = this.requireSubscription(id);
        const nowMs = this.now();
        subscription.expiresAt = nowMs + normalizeTtl(ttlMs, this.defaultTtlMs);
        return this.describeSubscription(subscription);
    }

    unsubscribe(id) {
        const subscription = this.requireSubscription(id);
        this.releaseWaiter(subscription);
        this.subscriptions.delete(id);
        return this.describeSubscription(subscription);
    }

    publish(input) {
        if (!input || typeof input !== "object") {
            throw new Error("event must be an object");
        }

        const topic = typeof input.topic === "string" ? input.topic.trim() : "";
        if (!topic) {
            throw new Error("event.topic must be a non-empty string");
        }

        this.registerTopic(topic);

        const nowMs = this.now();
        const event = {
            id: input.id || crypto.randomUUID(),
            sequence: ++this.sequence,
            topic,
            utcTime: normalizeTimestamp(input.utcTime, nowMs),
            propertyOperation: input.propertyOperation || "Changed",
            source: { ...(input.source || {}) },
            data: { ...(input.data || {}) }
        };

        const shouldRetain = input.retain !== false;
        if (shouldRetain) {
            this.retained.set(retainedEventKey({ ...input, ...event }), event);
        }

        this.pruneExpired();

        for (const subscription of this.subscriptions.values()) {
            if (!this.matchesSubscription(subscription, event)) {
                continue;
            }

            subscription.queue.push(event);
            if (subscription.queue.length > this.maxQueue) {
                subscription.queue.splice(
                    0,
                    subscription.queue.length - this.maxQueue
                );
            }

            this.releaseWaiter(subscription);
        }

        return event;
    }

    matchesSubscription(subscription, event) {
        return !subscription.topics || subscription.topics.has(event.topic);
    }

    pull(id, messageLimit) {
        const subscription = this.requireSubscription(id);
        const limit = normalizeMessageLimit(messageLimit);
        const messages = subscription.queue.splice(0, limit);

        return {
            subscription: this.describeSubscription(subscription),
            messages
        };
    }

    async pullAsync(id, messageLimit, timeoutMs = 0) {
        const subscription = this.requireSubscription(id);
        const limit = normalizeMessageLimit(messageLimit);
        const requestedTimeout = Number(timeoutMs);

        if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0) {
            throw new Error("timeoutMs must be a non-negative number");
        }

        if (subscription.queue.length > 0 || requestedTimeout === 0) {
            return this.pull(id, limit);
        }

        if (subscription.waiter) {
            throw new EventSubscriptionError(
                "concurrent-pull",
                `subscription already has a pending pull: ${id}`
            );
        }

        const remainingLifetime = Math.max(
            0,
            subscription.expiresAt - this.now() - 1
        );
        const waitMs = Math.min(
            Math.floor(requestedTimeout),
            remainingLifetime
        );

        if (waitMs <= 0) {
            return this.pull(id, limit);
        }

        await new Promise((resolve) => {
            const waiter = {
                resolve,
                timer: null
            };

            waiter.timer = setTimeout(() => {
                if (subscription.waiter === waiter) {
                    subscription.waiter = null;
                }
                resolve();
            }, waitMs);

            subscription.waiter = waiter;
        });

        return this.pull(id, limit);
    }

    releaseWaiter(subscription) {
        const waiter = subscription && subscription.waiter;
        if (!waiter) {
            return;
        }

        subscription.waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve();
    }

    setSynchronizationPoint(id) {
        const subscription = this.requireSubscription(id);
        const nowIso = new Date(this.now()).toISOString();
        let queued = 0;

        for (const event of this.retained.values()) {
            if (!this.matchesSubscription(subscription, event)) {
                continue;
            }

            subscription.queue.push({
                ...event,
                id: crypto.randomUUID(),
                sequence: ++this.sequence,
                utcTime: nowIso,
                propertyOperation: "Initialized",
                source: { ...event.source },
                data: { ...event.data }
            });
            queued += 1;
        }

        if (subscription.queue.length > this.maxQueue) {
            subscription.queue.splice(
                0,
                subscription.queue.length - this.maxQueue
            );
        }

        if (queued > 0) {
            this.releaseWaiter(subscription);
        }

        return queued;
    }

    pruneExpired() {
        const nowMs = this.now();

        for (const [id, subscription] of this.subscriptions.entries()) {
            if (subscription.expiresAt <= nowMs) {
                this.releaseWaiter(subscription);
                this.subscriptions.delete(id);
            }
        }
    }
}

module.exports = {
    DEFAULT_SUBSCRIPTION_TTL_MS,
    DEFAULT_MAX_QUEUE,
    EventSubscriptionError,
    EventBus,
    retainedEventKey
};
