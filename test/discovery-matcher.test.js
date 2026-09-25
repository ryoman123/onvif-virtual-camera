const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LEGACY_RFC3986_MATCH,
    parseProbeConstraints,
    matchesTypes,
    normalizeScopeUri,
    rfc3986ScopeMatches,
    isSupportedMatchBy,
    matchesScopes,
    matchesProbe
} = require("../src/discovery-matcher");
const { getDiscoveryScopeUris } = require("../src/onvif-scopes");

function cameraFixture() {
    return {
        name: "Camera-Test",
        identity: {
            manufacturer: "VirtualCam",
            model: "Test Virtual Camera"
        },
        host: {
            hostname: "192.0.2.57"
        }
    };
}

function probeXml({
    types = null,
    scopes = null,
    matchBy = null,
    tdsPrefix = "tds",
    dnPrefix = "dn"
} = {}) {
    const typesXml = types === null ? "" : `<d:Types>${types}</d:Types>`;
    const matchByAttr = matchBy ? ` MatchBy="${matchBy}"` : "";
    const scopesXml = scopes === null ? "" : `<d:Scopes${matchByAttr}>${scopes}</d:Scopes>`;

    return `<?xml version="1.0"?>
<s:Envelope
    xmlns:s="http://www.w3.org/2003/05/soap-envelope"
    xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
    xmlns:${tdsPrefix}="http://www.onvif.org/ver10/device/wsdl"
    xmlns:${dnPrefix}="http://www.onvif.org/ver10/network/wsdl">
  <s:Body>
    <d:Probe>
      ${typesXml}
      ${scopesXml}
    </d:Probe>
  </s:Body>
</s:Envelope>`;
}

test("empty Probe constraints match an ONVIF camera", () => {
    const constraints = parseProbeConstraints(probeXml());
    assert.ok(constraints);
    assert.deepEqual(constraints.types, []);
    assert.deepEqual(constraints.scopes, []);
    assert.equal(
        matchesProbe(cameraFixture(), constraints, getDiscoveryScopeUris),
        true
    );
});

test("tds:Device matches by namespace URI, independent of prefix text", () => {
    const constraints = parseProbeConstraints(
        probeXml({
            types: "dev:Device",
            tdsPrefix: "dev"
        })
    );

    assert.deepEqual(constraints.types, [{
        namespace: "http://www.onvif.org/ver10/device/wsdl",
        localName: "Device"
    }]);
    assert.equal(matchesTypes(constraints.types), true);
});

test("legacy dn:NetworkVideoTransmitter remains supported", () => {
    const constraints = parseProbeConstraints(
        probeXml({
            types: "legacy:NetworkVideoTransmitter",
            dnPrefix: "legacy"
        })
    );

    assert.equal(matchesTypes(constraints.types), true);
});

test("unknown or unresolved Probe Types do not match", () => {
    const wrongType = parseProbeConstraints(
        probeXml({ types: "tds:Media" })
    );
    const unknownPrefix = parseProbeConstraints(
        probeXml({ types: "nope:Device" })
    );

    assert.equal(matchesTypes(wrongType.types), false);
    assert.equal(matchesTypes(unknownPrefix.types), false);
});

test("all requested Types must match", () => {
    const allKnown = parseProbeConstraints(
        probeXml({ types: "tds:Device dn:NetworkVideoTransmitter" })
    );
    const oneUnknown = parseProbeConstraints(
        probeXml({ types: "tds:Device tds:Media" })
    );

    assert.equal(matchesTypes(allKnown.types), true);
    assert.equal(matchesTypes(oneUnknown.types), false);
});

test("RFC3986 scope matching is segment-wise, not raw string prefix", () => {
    assert.equal(
        rfc3986ScopeMatches(
            "onvif://www.onvif.org",
            "onvif://www.onvif.org/location/192.0.2.57"
        ),
        true
    );
    assert.equal(
        rfc3986ScopeMatches(
            "onvif://www.onvif.org/location",
            "onvif://www.onvif.org/location/192.0.2.57"
        ),
        true
    );
    assert.equal(
        rfc3986ScopeMatches(
            "onvif://www.onvif.org/loc",
            "onvif://www.onvif.org/location/192.0.2.57"
        ),
        false
    );
});

test("RFC3986 scope matching canonicalizes percent-encoding and ignores query/fragment", () => {
    assert.equal(
        rfc3986ScopeMatches(
            "onvif://WWW.ONVIF.ORG/name/Test%20Virtual%20Camera?ignored=yes",
            "onvif://www.onvif.org/name/Test%20Virtual%20Camera#ignored"
        ),
        true
    );
});

test("dot path segments are rejected for RFC3986 matching", () => {
    assert.equal(normalizeScopeUri("onvif://www.onvif.org/location/../secret"), null);
    assert.equal(
        rfc3986ScopeMatches(
            "onvif://www.onvif.org/location/..",
            "onvif://www.onvif.org/location/192.0.2.57"
        ),
        false
    );
});

test("all requested Scopes must match at least one target scope", () => {
    const targetScopes = getDiscoveryScopeUris(cameraFixture());

    assert.equal(
        matchesScopes(
            [
                "onvif://www.onvif.org/Profile/Streaming",
                "onvif://www.onvif.org/location"
            ],
            targetScopes,
            LEGACY_RFC3986_MATCH
        ),
        true
    );

    assert.equal(
        matchesScopes(
            [
                "onvif://www.onvif.org/Profile/Streaming",
                "onvif://www.onvif.org/hardware/Definitely%20Not%20This%20Camera"
            ],
            targetScopes,
            LEGACY_RFC3986_MATCH
        ),
        false
    );
});

test("legacy and OASIS RFC3986 MatchBy URIs are accepted", () => {
    assert.equal(
        isSupportedMatchBy("http://schemas.xmlsoap.org/ws/2005/04/discovery/rfc3986"),
        true
    );
    assert.equal(
        isSupportedMatchBy("http://docs.oasis-open.org/ws-dd/ns/discovery/2008/09/rfc3986"),
        true
    );
    assert.equal(
        isSupportedMatchBy("http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01/rfc3986"),
        true
    );
});

test("unsupported MatchBy causes a scoped Probe not to match", () => {
    const targetScopes = getDiscoveryScopeUris(cameraFixture());

    assert.equal(
        matchesScopes(
            ["onvif://www.onvif.org/Profile/Streaming"],
            targetScopes,
            "urn:example:unsupported-match-rule"
        ),
        false
    );
});

test("Probe parsing defaults Scope MatchBy to legacy RFC3986 for this WS-Discovery version", () => {
    const constraints = parseProbeConstraints(
        probeXml({
            scopes: "onvif://www.onvif.org/Profile/Streaming"
        })
    );

    assert.equal(constraints.matchBy, LEGACY_RFC3986_MATCH);
});

test("combined Type and Scope constraints both apply", () => {
    const matching = parseProbeConstraints(
        probeXml({
            types: "tds:Device",
            scopes: "onvif://www.onvif.org/Profile/Streaming"
        })
    );
    const wrongScope = parseProbeConstraints(
        probeXml({
            types: "tds:Device",
            scopes: "onvif://www.onvif.org/location/nowhere"
        })
    );

    assert.equal(
        matchesProbe(cameraFixture(), matching, getDiscoveryScopeUris),
        true
    );
    assert.equal(
        matchesProbe(cameraFixture(), wrongScope, getDiscoveryScopeUris),
        false
    );
});
