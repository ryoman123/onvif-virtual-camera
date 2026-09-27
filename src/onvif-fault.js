const SOAP_SENDER = "soap:Sender";
const SOAP_RECEIVER = "soap:Receiver";

function buildSubcode(values) {
    if (!Array.isArray(values) || values.length === 0) {
        return undefined;
    }

    const [value, ...rest] = values;
    const subcode = { Value: value };
    const nested = buildSubcode(rest);

    if (nested) {
        subcode.Subcode = nested;
    }

    return subcode;
}

function createFault({ sender = true, subcodes = [], reason, statusCode = 500 }) {
    const code = {
        Value: sender ? SOAP_SENDER : SOAP_RECEIVER
    };

    const subcode = buildSubcode(subcodes);
    if (subcode) {
        code.Subcode = subcode;
    }

    return {
        Fault: {
            Code: code,
            Reason: {
                Text: reason
            },
            statusCode
        }
    };
}

function invalidArgs() {
    return createFault({
        subcodes: ["ter:InvalidArgs"],
        reason: "Invalid Args"
    });
}

function noProfile() {
    return createFault({
        subcodes: ["ter:InvalidArgVal", "ter:NoProfile"],
        reason: "Argument Value Invalid"
    });
}

function noConfig() {
    return createFault({
        subcodes: ["ter:InvalidArgVal", "ter:NoConfig"],
        reason: "Argument Value Invalid"
    });
}

function invalidStreamSetup() {
    return createFault({
        subcodes: ["ter:InvalidArgVal", "ter:InvalidStreamSetup"],
        reason: "Argument Value Invalid"
    });
}

module.exports = {
    createFault,
    invalidArgs,
    noProfile,
    noConfig,
    invalidStreamSetup
};
