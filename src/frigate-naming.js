function toFrigateCameraName(value) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");

    if (!normalized) {
        throw new Error("Camera name cannot be converted to a Frigate identifier");
    }

    return normalized;
}

module.exports = { toFrigateCameraName };
