const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAnalyticsEvent } = require("../src/analytics-event");

const event = { camera: "VirtualCam1", type: "person" };

test("rejects invalid analytics timestamps before dispatch", () => {
    for (const utcTime of ["not-a-date", Infinity, "", 8640000000000001]) {
        assert.throws(() => normalizeAnalyticsEvent({ ...event, utcTime }), /utcTime/);
    }
    assert.equal(normalizeAnalyticsEvent({ ...event, utcTime: 0 }).utcTime, "1970-01-01T00:00:00.000Z");
});

test("normalizes finite four-coordinate boxes and rejects malformed ones", () => {
    assert.deepEqual(normalizeAnalyticsEvent({ ...event, box: ["0", 0.25, "0.5", 1] }).box, [0, 0.25, 0.5, 1]);
    for (const box of [[1, 2, 3], [0, 1, 2, 3, 4], [0, NaN, 2, 3], [0, Infinity, 2, 3], "0,1,2,3"]) {
        assert.throws(() => normalizeAnalyticsEvent({ ...event, box }), /box/);
    }
});
