const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");

const {
    SimpleMqttClient,
    encodeRemainingLength,
    decodeRemainingLength
} = require("../src/simple-mqtt-client");

function encodeString(value) {
    const data = Buffer.from(value);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length, 0);
    return Buffer.concat([length, data]);
}

function publishPacket(topic, payload) {
    const body = Buffer.concat([encodeString(topic), Buffer.from(payload)]);
    return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]);
}

test("built-in MQTT client connects, subscribes, and receives a Frigate message", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    server.on("connection", (socket) => {
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length >= 2) {
                const remaining = decodeRemainingLength(buffer, 1);
                if (!remaining) return;

                const headerLength = 1 + remaining.bytes;
                const total = headerLength + remaining.value;
                if (buffer.length < total) return;

                const first = buffer[0];
                const body = buffer.subarray(headerLength, total);
                buffer = buffer.subarray(total);

                if ((first >> 4) === 1) {
                    socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
                } else if ((first >> 4) === 8) {
                    const packetId = body.readUInt16BE(0);
                    socket.write(Buffer.from([
                        0x90, 0x03,
                        packetId >> 8, packetId & 0xff,
                        0x00
                    ]));
                    socket.write(publishPacket("frigate/available", "online"));
                }
            }
        });
    });

    const client = new SimpleMqttClient("mqtt://127.0.0.1:" + port, {
        clientId: "onvif-test",
        reconnectPeriod: 0,
        connectTimeout: 2000,
        keepalive: 0
    });

    try {
        await once(client, "connect");

        const subscribed = new Promise((resolve, reject) => {
            client.subscribe(["frigate/available"], { qos: 0 }, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
        const message = once(client, "message");

        await subscribed;
        const [topic, payload] = await message;
        assert.equal(topic, "frigate/available");
        assert.equal(payload.toString(), "online");
    } finally {
        await new Promise((resolve) => client.end(false, {}, resolve));
        await new Promise((resolve) => server.close(resolve));
    }
});
