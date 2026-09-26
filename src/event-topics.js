const TOPICS = Object.freeze({
    MOTION: "RuleEngine/CellMotionDetector/Motion",
    PERSON: "UserAlarm/IVA/HumanShapeDetect",
    VEHICLE: "VehicleAlarm/IVB/VehicleDetect",
    ANIMAL: "UserAlarm/IVA/AnimalDetect",
    PACKAGE: "UserAlarm/IVA/PackageDetect"
});

const DEFAULT_TOPICS = Object.freeze(Object.values(TOPICS));

module.exports = {
    TOPICS,
    DEFAULT_TOPICS
};
