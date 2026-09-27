const EVENT_TYPE_MAP = Object.freeze({
    VideoMotion: "motion",
    SmartMotionHuman: "person",
    SmartMotionVehicle: "vehicle"
});

function parseDahuaEventLine(line) {
    const text = String(line || "").trim();
    if (!text.startsWith("Code=")) return null;

    const fields = {};
    for (const part of text.split(";")) {
        const index = part.indexOf("=");
        if (index < 1) continue;
        fields[part.slice(0, index)] = part.slice(index + 1);
    }

    const type = EVENT_TYPE_MAP[fields.Code];
    if (!type) return null;

    const action = String(fields.action || "").toLowerCase();
    if (!["start", "stop", "pulse"].includes(action)) return null;

    const channel = Number(fields.index);
    if (!Number.isInteger(channel) || channel < 0) return null;

    let data = null;
    if (fields.data) {
        try { data = JSON.parse(fields.data); } catch { data = null; }
    }

    return Object.freeze({
        source: "dahua",
        channel,
        type,
        active: action !== "stop",
        action,
        data
    });
}

class DahuaEventStreamParser {
    constructor(onEvent) {
        if (typeof onEvent !== "function") throw new Error("Dahua parser requires an event callback");
        this.onEvent = onEvent;
        this.buffer = "";
    }

    push(chunk) {
        this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || "";
        for (const line of lines) {
            const event = parseDahuaEventLine(line);
            if (event) this.onEvent(event);
        }
    }

    flush() {
        const event = parseDahuaEventLine(this.buffer);
        this.buffer = "";
        if (event) this.onEvent(event);
    }
}

module.exports = { EVENT_TYPE_MAP, parseDahuaEventLine, DahuaEventStreamParser };
