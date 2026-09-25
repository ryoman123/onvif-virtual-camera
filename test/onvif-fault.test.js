const test = require("node:test");
const assert = require("node:assert/strict");

const faults = require("../src/onvif-fault");

test("NoProfile fault uses the ONVIF nested subcode chain", () => {
    assert.deepEqual(faults.noProfile(), {
        Fault: {
            Code: {
                Value: "soap:Sender",
                Subcode: {
                    Value: "ter:InvalidArgVal",
                    Subcode: {
                        Value: "ter:NoProfile"
                    }
                }
            },
            Reason: {
                Text: "Argument Value Invalid"
            },
            statusCode: 500
        }
    });
});

test("NoConfig fault uses the ONVIF nested subcode chain", () => {
    assert.deepEqual(faults.noConfig().Fault.Code, {
        Value: "soap:Sender",
        Subcode: {
            Value: "ter:InvalidArgVal",
            Subcode: {
                Value: "ter:NoConfig"
            }
        }
    });
});

test("InvalidArgs is a sender fault", () => {
    assert.deepEqual(faults.invalidArgs().Fault.Code, {
        Value: "soap:Sender",
        Subcode: {
            Value: "ter:InvalidArgs"
        }
    });
});

test("generic fault helper supports receiver faults", () => {
    const fault = faults.createFault({
        sender: false,
        subcodes: ["ter:ActionNotSupported"],
        reason: "Optional Action Not Implemented"
    });

    assert.equal(fault.Fault.Code.Value, "soap:Receiver");
    assert.equal(fault.Fault.Code.Subcode.Value, "ter:ActionNotSupported");
});
