const EventEmitter = require("events");
const net = require("net");
const tls = require("tls");

function encodeRemainingLength(length) {
    if (!Number.isInteger(length) || length < 0 || length > 268435455) {
        throw new Error("MQTT remaining length is out of range");
    }

    const bytes = [];
    do {
        let digit = length % 128;
        length = Math.floor(length / 128);
        if (length > 0) digit |= 0x80;
        bytes.push(digit);
    } while (length > 0);

    return Buffer.from(bytes);
}

function encodeString(value) {
    const data = Buffer.from(String(value), "utf8");
    if (data.length > 65535) {
        throw new Error("MQTT string is too long");
    }

    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length, 0);
    return Buffer.concat([length, data]);
}

function packet(typeAndFlags, body = Buffer.alloc(0)) {
    return Buffer.concat([
        Buffer.from([typeAndFlags]),
        encodeRemainingLength(body.length),
        body
    ]);
}

function buildConnectPacket(options = {}) {
    const protocol = Buffer.concat([
        encodeString("MQTT"),
        Buffer.from([4])
    ]);

    const username = options.username === undefined || options.username === null
        ? null
        : String(options.username);
    const password = options.password === undefined || options.password === null
        ? null
        : String(options.password);

    let flags = options.clean === false ? 0 : 0x02;
    if (username !== null) flags |= 0x80;
    if (password !== null) flags |= 0x40;

    const keepalive = Number.isInteger(options.keepalive)
        ? Math.max(0, Math.min(65535, options.keepalive))
        : 30;
    const keepaliveBuffer = Buffer.alloc(2);
    keepaliveBuffer.writeUInt16BE(keepalive, 0);

    const payload = [encodeString(options.clientId || "onvif-vcam")];
    if (username !== null) payload.push(encodeString(username));
    if (password !== null) payload.push(encodeString(password));

    return packet(0x10, Buffer.concat([
        protocol,
        Buffer.from([flags]),
        keepaliveBuffer,
        ...payload
    ]));
}

function buildSubscribePacket(packetId, topics, qos = 0) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(packetId, 0);
    const payload = [];

    for (const topic of topics) {
        payload.push(encodeString(topic), Buffer.from([qos]));
    }

    return packet(0x82, Buffer.concat([id, ...payload]));
}

function decodeRemainingLength(buffer, offset = 1) {
    let multiplier = 1;
    let value = 0;
    let bytes = 0;

    while (offset + bytes < buffer.length && bytes < 4) {
        const digit = buffer[offset + bytes];
        value += (digit & 0x7f) * multiplier;
        bytes += 1;

        if ((digit & 0x80) === 0) {
            return { value, bytes };
        }

        multiplier *= 128;
    }

    return null;
}

class SimpleMqttClient extends EventEmitter {
    constructor(brokerUrl, options = {}) {
        super();

        this.url = new URL(brokerUrl);
        if (!["mqtt:", "mqtts:"].includes(this.url.protocol)) {
            throw new Error("MQTT broker URL must use mqtt:// or mqtts://");
        }

        this.options = {
            reconnectPeriod: 5000,
            connectTimeout: 30000,
            clean: true,
            keepalive: 30,
            clientId: "onvif-vcam",
            ...options
        };

        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.connected = false;
        this.ending = false;
        this.reconnectTimer = null;
        this.connectTimer = null;
        this.keepaliveTimer = null;
        this.awaitingPingResponse = false;
        this.nextPacketId = 1;
        this.pendingSubscribes = new Map();

        this.open();
    }

    open() {
        if (this.ending) return;

        this.clearSocketTimers();
        this.buffer = Buffer.alloc(0);
        this.awaitingPingResponse = false;

        const host = this.url.hostname;
        const port = Number(this.url.port || (this.url.protocol === "mqtts:" ? 8883 : 1883));
        const socketOptions = { host, port };

        const socket = this.url.protocol === "mqtts:"
            ? tls.connect(socketOptions)
            : net.createConnection(socketOptions);

        this.socket = socket;

        const onConnected = () => {
            if (socket !== this.socket || this.ending) return;
            socket.write(buildConnectPacket({
                clientId: this.options.clientId,
                username: this.options.username,
                password: this.options.password,
                clean: this.options.clean,
                keepalive: this.options.keepalive
            }));
        };

        if (this.url.protocol === "mqtts:") {
            socket.once("secureConnect", onConnected);
        } else {
            socket.once("connect", onConnected);
        }

        socket.on("data", (chunk) => this.handleData(chunk));
        socket.on("error", (error) => {
            if (!this.ending) this.emit("error", error);
        });
        socket.on("close", () => this.handleClose(socket));

        this.connectTimer = setTimeout(() => {
            if (socket === this.socket && !this.connected && !this.ending) {
                socket.destroy(new Error("MQTT connection timed out"));
            }
        }, this.options.connectTimeout);

        if (typeof this.connectTimer.unref === "function") this.connectTimer.unref();
    }

    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length >= 2) {
            const remaining = decodeRemainingLength(this.buffer, 1);
            if (!remaining) return;

            const headerBytes = 1 + remaining.bytes;
            const total = headerBytes + remaining.value;
            if (this.buffer.length < total) return;

            const first = this.buffer[0];
            const body = this.buffer.subarray(headerBytes, total);
            this.buffer = this.buffer.subarray(total);
            this.handlePacket(first, body);
        }
    }

    handlePacket(first, body) {
        const type = first >> 4;

        if (type === 2) {
            if (body.length < 2 || body[1] !== 0) {
                const code = body.length >= 2 ? body[1] : -1;
                this.emit("error", new Error("MQTT broker rejected connection (code " + code + ")"));
                this.socket?.destroy();
                return;
            }

            this.connected = true;
            this.awaitingPingResponse = false;
            if (this.connectTimer) {
                clearTimeout(this.connectTimer);
                this.connectTimer = null;
            }
            this.startKeepalive();
            this.emit("connect");
            return;
        }

        if (type === 9) {
            if (body.length < 3) return;
            const packetId = body.readUInt16BE(0);
            const pending = this.pendingSubscribes.get(packetId);
            this.pendingSubscribes.delete(packetId);
            if (pending) {
                const failure = Array.from(body.subarray(2)).some((code) => code === 0x80);
                pending(failure ? new Error("MQTT broker rejected subscription") : null);
            }
            return;
        }

        if (type === 3) {
            this.handlePublish(first, body);
            return;
        }

        if (type === 13) {
            this.awaitingPingResponse = false;
            return;
        }
    }

    handlePublish(first, body) {
        if (body.length < 2) return;
        const topicLength = body.readUInt16BE(0);
        if (body.length < 2 + topicLength) return;

        let offset = 2;
        const topic = body.subarray(offset, offset + topicLength).toString("utf8");
        offset += topicLength;

        const qos = (first >> 1) & 0x03;
        let packetId = null;
        if (qos > 0) {
            if (body.length < offset + 2) return;
            packetId = body.readUInt16BE(offset);
            offset += 2;
        }

        const payload = body.subarray(offset);
        this.emit("message", topic, payload);

        if (qos === 1 && packetId !== null && this.socket && !this.socket.destroyed) {
            const id = Buffer.alloc(2);
            id.writeUInt16BE(packetId, 0);
            this.socket.write(packet(0x40, id));
        }
    }

    subscribe(topics, options = {}, callback = () => {}) {
        const list = Array.isArray(topics) ? topics : [topics];
        if (!this.connected || !this.socket || this.socket.destroyed) {
            callback(new Error("MQTT client is not connected"));
            return;
        }

        const packetId = this.allocatePacketId();
        this.pendingSubscribes.set(packetId, callback);
        this.socket.write(buildSubscribePacket(packetId, list, options.qos || 0));
    }

    allocatePacketId() {
        const packetId = this.nextPacketId;
        this.nextPacketId = this.nextPacketId >= 65535 ? 1 : this.nextPacketId + 1;
        return packetId;
    }

    startKeepalive() {
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        if (!this.options.keepalive) return;

        this.keepaliveTimer = setInterval(() => {
            if (this.connected && this.socket && !this.socket.destroyed) {
                if (this.awaitingPingResponse) {
                    this.socket.destroy(new Error("MQTT keepalive timed out waiting for PINGRESP"));
                    return;
                }
                this.awaitingPingResponse = true;
                this.socket.write(packet(0xc0));
            }
        }, Math.max(1000, this.options.keepalive * 500));

        if (typeof this.keepaliveTimer.unref === "function") this.keepaliveTimer.unref();
    }

    clearSocketTimers() {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        this.awaitingPingResponse = false;
    }

    handleClose(socket) {
        if (socket !== this.socket) return;

        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.clearSocketTimers();

        for (const callback of this.pendingSubscribes.values()) {
            callback(new Error("MQTT connection closed before subscription completed"));
        }
        this.pendingSubscribes.clear();

        this.emit("close");
        if (this.ending) return;

        if (wasConnected) this.emit("offline");

        const delay = Math.max(0, Number(this.options.reconnectPeriod) || 0);
        if (delay === 0) return;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.ending) return;
            this.emit("reconnect");
            this.open();
        }, delay);

        if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
    }

    end(force = false, options = {}, callback = () => {}) {
        this.ending = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.clearSocketTimers();

        const socket = this.socket;
        this.socket = null;
        this.connected = false;

        if (!socket) {
            callback();
            return;
        }

        socket.once("close", callback);

        if (!force && !socket.destroyed) {
            try {
                socket.write(packet(0xe0));
                socket.end();
                return;
            } catch (error) {
                socket.destroy();
                callback(error);
                return;
            }
        }

        socket.destroy();
    }
}

function connectMqtt(brokerUrl, options) {
    return new SimpleMqttClient(brokerUrl, options);
}

module.exports = {
    SimpleMqttClient,
    connectMqtt,
    encodeRemainingLength,
    decodeRemainingLength,
    buildConnectPacket,
    buildSubscribePacket
};
