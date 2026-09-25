const TYPE_NAMESPACES = {
    "http://www.onvif.org/ver10/device/wsdl": new Set(["Device"]),
    "http://www.onvif.org/ver10/network/wsdl": new Set(["NetworkVideoTransmitter"])
};

const LEGACY_RFC3986_MATCH = "http://schemas.xmlsoap.org/ws/2005/04/discovery/rfc3986";
const OASIS_RFC3986_MATCHES = new Set([
    "http://docs.oasis-open.org/ws-dd/ns/discovery/2008/09/rfc3986",
    "http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01/rfc3986"
]);

function extractNamespaceMap(xml) {
    const map = new Map();
    const regex = /\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*["']([^"']+)["']/g;
    let match;

    while ((match = regex.exec(xml)) !== null) {
        map.set(match[1] || "", match[2]);
    }

    return map;
}

function extractProbeBody(xml) {
    const match = xml.match(/<(?:[A-Za-z_][\w.-]*:)?Probe\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?Probe>/i);
    return match ? match[1] : null;
}

function extractElement(body, localName) {
    const regex = new RegExp(
        `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}>`,
        "i"
    );
    const match = body.match(regex);

    if (!match) {
        return null;
    }

    return {
        attributes: match[1] || "",
        text: match[2].trim()
    };
}

function parseQName(value, namespaces) {
    const parts = value.split(":");
    const prefix = parts.length > 1 ? parts[0] : "";
    const localName = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
    const namespace = namespaces.get(prefix);

    if (!localName || namespace === undefined) {
        return null;
    }

    return { namespace, localName };
}

function parseProbeConstraints(xml) {
    const body = extractProbeBody(xml);
    if (body === null) {
        return null;
    }

    const namespaces = extractNamespaceMap(xml);
    const typesElement = extractElement(body, "Types");
    const scopesElement = extractElement(body, "Scopes");

    const types = typesElement && typesElement.text
        ? typesElement.text.split(/\s+/).filter(Boolean).map((value) => parseQName(value, namespaces))
        : [];

    let matchBy = LEGACY_RFC3986_MATCH;
    if (scopesElement) {
        const match = scopesElement.attributes.match(/\bMatchBy\s*=\s*["']([^"']+)["']/i);
        if (match) {
            matchBy = match[1];
        }
    }

    const scopes = scopesElement && scopesElement.text
        ? scopesElement.text.split(/\s+/).filter(Boolean)
        : [];

    return {
        types,
        scopes,
        matchBy
    };
}

function matchesTypes(types) {
    if (!types || types.length === 0) {
        return true;
    }

    return types.every((type) => {
        if (!type) {
            return false;
        }

        const localNames = TYPE_NAMESPACES[type.namespace];
        return !!localNames && localNames.has(type.localName);
    });
}

function normalizeScopeUri(value) {
    let url;

    try {
        url = new URL(value);
    } catch (_) {
        return null;
    }

    const segments = url.pathname.split("/");

    if (segments[0] === "") {
        segments.shift();
    }

    while (segments.length > 0 && segments[segments.length - 1] === "") {
        segments.pop();
    }

    let decoded;
    try {
        decoded = segments.map((segment) => decodeURIComponent(segment));
    } catch (_) {
        return null;
    }

    if (decoded.some((segment) => segment === "." || segment === "..")) {
        return null;
    }

    return {
        scheme: url.protocol.slice(0, -1).toLowerCase(),
        authority: url.host.toLowerCase(),
        segments: decoded
    };
}

function rfc3986ScopeMatches(probeScope, targetScope) {
    const probe = normalizeScopeUri(probeScope);
    const target = normalizeScopeUri(targetScope);

    if (!probe || !target) {
        return false;
    }

    if (probe.scheme !== target.scheme || probe.authority !== target.authority) {
        return false;
    }

    if (probe.segments.length > target.segments.length) {
        return false;
    }

    return probe.segments.every((segment, index) => segment === target.segments[index]);
}

function isSupportedMatchBy(matchBy) {
    return !matchBy
        || matchBy === LEGACY_RFC3986_MATCH
        || OASIS_RFC3986_MATCHES.has(matchBy);
}

function matchesScopes(scopes, targetScopes, matchBy) {
    if (!scopes || scopes.length === 0) {
        return true;
    }

    if (!isSupportedMatchBy(matchBy)) {
        return false;
    }

    return scopes.every((probeScope) =>
        targetScopes.some((targetScope) => rfc3986ScopeMatches(probeScope, targetScope))
    );
}

function matchesProbe(camera, constraints, getTargetScopes) {
    if (!constraints) {
        return false;
    }

    if (!matchesTypes(constraints.types)) {
        return false;
    }

    const targetScopes = getTargetScopes(camera);
    return matchesScopes(constraints.scopes, targetScopes, constraints.matchBy);
}

module.exports = {
    LEGACY_RFC3986_MATCH,
    OASIS_RFC3986_MATCHES,
    extractNamespaceMap,
    parseProbeConstraints,
    matchesTypes,
    normalizeScopeUri,
    rfc3986ScopeMatches,
    isSupportedMatchBy,
    matchesScopes,
    matchesProbe
};
