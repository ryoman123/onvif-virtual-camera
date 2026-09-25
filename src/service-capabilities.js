const DEVICE_NAMESPACE = "http://www.onvif.org/ver10/device/wsdl";
const MEDIA_NAMESPACE = "http://www.onvif.org/ver10/media/wsdl";

function buildDeviceServiceCapabilities() {
    return {
        Network: {
            $attributes: {
                IPFilter: false,
                ZeroConfiguration: false,
                IPVersion6: false,
                DynDNS: false,
                Dot11Configuration: false,
                Dot1XConfigurations: 0,
                HostnameFromDHCP: false,
                NTP: 0,
                DHCPv6: false
            }
        },
        Security: {
            $attributes: {
                "TLS1.0": false,
                "TLS1.1": false,
                "TLS1.2": false,
                OnboardKeyGeneration: false,
                AccessPolicyConfig: false,
                DefaultAccessPolicy: false,
                Dot1X: false,
                RemoteUserHandling: false,
                "X.509Token": false,
                SAMLToken: false,
                KerberosToken: false,
                UsernameToken: true,
                HttpDigest: false,
                RELToken: false
            }
        },
        System: {
            $attributes: {
                DiscoveryResolve: true,
                DiscoveryBye: true,
                RemoteDiscovery: false,
                SystemBackup: false,
                SystemLogging: false,
                FirmwareUpgrade: false,
                HttpFirmwareUpgrade: false,
                HttpSystemBackup: false,
                HttpSystemLogging: false,
                HttpSupportInformation: false
            }
        }
    };
}

function buildMediaServiceCapabilities() {
    return {
        $attributes: {
            SnapshotUri: true,
            Rotation: false,
            VideoSourceMode: false,
            OSD: false
        },
        ProfileCapabilities: {
            $attributes: {
                MaximumNumberOfProfiles: 2
            }
        },
        StreamingCapabilities: {
            $attributes: {
                RTPMulticast: false,
                RTP_TCP: true,
                RTP_RTSP_TCP: true,
                NonAggregateControl: false,
                NoRTSPStreaming: false
            }
        }
    };
}

function xmlAttributeValue(value) {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function renderAttributes(attributes) {
    return Object.entries(attributes || {})
        .map(([name, value]) => `${name}="${xmlAttributeValue(value)}"`)
        .join(" ");
}

function renderDeviceServiceCapabilitiesXml(capabilities = buildDeviceServiceCapabilities()) {
    return [
        `<tds:Capabilities xmlns:tds="${DEVICE_NAMESPACE}">`,
        `<tds:Network ${renderAttributes(capabilities.Network.$attributes)} />`,
        `<tds:Security ${renderAttributes(capabilities.Security.$attributes)} />`,
        `<tds:System ${renderAttributes(capabilities.System.$attributes)} />`,
        "</tds:Capabilities>"
    ].join("");
}

function renderMediaServiceCapabilitiesXml(capabilities = buildMediaServiceCapabilities()) {
    return [
        `<trt:Capabilities xmlns:trt="${MEDIA_NAMESPACE}" ${renderAttributes(capabilities.$attributes)}>`,
        `<trt:ProfileCapabilities ${renderAttributes(capabilities.ProfileCapabilities.$attributes)} />`,
        `<trt:StreamingCapabilities ${renderAttributes(capabilities.StreamingCapabilities.$attributes)} />`,
        "</trt:Capabilities>"
    ].join("");
}

module.exports = {
    DEVICE_NAMESPACE,
    MEDIA_NAMESPACE,
    buildDeviceServiceCapabilities,
    buildMediaServiceCapabilities,
    renderDeviceServiceCapabilitiesXml,
    renderMediaServiceCapabilitiesXml
};
