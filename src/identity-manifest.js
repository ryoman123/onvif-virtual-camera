const REQUIRED_IDENTITY_FIELDS = Object.freeze([
    "name",
    "mac",
    "serialNumber",
    "hardwareId"
]);

function buildIdentityManifest(status, expectedCameras) {
    if (status?.status !== "healthy") {
        throw new Error(`bridge status must be healthy (found ${status?.status || "missing"})`);
    }

    const cameras = status?.cameras?.items;
    if (!Array.isArray(cameras) || cameras.length === 0) {
        throw new Error("status must contain at least one virtual camera");
    }
    if (expectedCameras !== undefined && cameras.length !== expectedCameras) {
        throw new Error(`expected ${expectedCameras} cameras, found ${cameras.length}`);
    }
    if (status.cameras.total !== cameras.length || status.cameras.healthy !== cameras.length) {
        throw new Error(
            `camera inventory is not fully healthy (${status.cameras.healthy}/${status.cameras.total}, ${cameras.length} items)`
        );
    }

    const seen = Object.fromEntries(REQUIRED_IDENTITY_FIELDS.map((field) => [field, new Set()]));
    const manifest = cameras.map((camera, index) => {
        const identity = {
            name: camera?.name,
            mac: camera?.mac,
            serialNumber: camera?.identity?.serialNumber,
            hardwareId: camera?.identity?.hardwareId
        };

        for (const field of REQUIRED_IDENTITY_FIELDS) {
            const value = identity[field];
            if (typeof value !== "string" || !value.trim()) {
                throw new Error(`camera ${index} is missing ${field}`);
            }
            identity[field] = value.trim();
            const key = field === "mac" ? identity[field].toLowerCase() : identity[field];
            if (seen[field].has(key)) {
                throw new Error(`duplicate camera ${field}: ${identity[field]}`);
            }
            seen[field].add(key);
        }

        return Object.freeze(identity);
    });

    manifest.sort((left, right) => left.name.localeCompare(right.name));
    return Object.freeze({ cameras: Object.freeze(manifest) });
}

module.exports = { REQUIRED_IDENTITY_FIELDS, buildIdentityManifest };
