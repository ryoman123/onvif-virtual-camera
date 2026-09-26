const TOPICS = Object.freeze({
    MOTION: "RuleEngine/CellMotionDetector/Motion",
    PERSON: "UserAlarm/IVA/HumanShapeDetect",
    VEHICLE: "VehicleAlarm/IVB/VehicleDetect",
    ANIMAL: "UserAlarm/IVA/AnimalDetect",
    PACKAGE: "UserAlarm/IVA/PackageDetect"
});

const TOPIC_DEFINITIONS = Object.freeze([
    Object.freeze({
        key: "MOTION",
        topic: TOPICS.MOTION,
        isProperty: true,
        source: Object.freeze([
            Object.freeze({
                name: "VideoSourceConfigurationToken",
                type: "tt:ReferenceToken"
            })
        ]),
        data: Object.freeze([
            Object.freeze({
                name: "IsMotion",
                type: "xs:boolean"
            })
        ])
    }),
    Object.freeze({
        key: "PERSON",
        topic: TOPICS.PERSON,
        isProperty: true,
        source: Object.freeze([
            Object.freeze({
                name: "VideoSourceConfigurationToken",
                type: "tt:ReferenceToken"
            })
        ]),
        data: Object.freeze([
            Object.freeze({
                name: "State",
                type: "xs:boolean"
            })
        ])
    }),
    Object.freeze({
        key: "VEHICLE",
        topic: TOPICS.VEHICLE,
        isProperty: true,
        source: Object.freeze([
            Object.freeze({
                name: "VideoSourceConfigurationToken",
                type: "tt:ReferenceToken"
            })
        ]),
        data: Object.freeze([
            Object.freeze({
                name: "State",
                type: "xs:boolean"
            })
        ])
    }),
    Object.freeze({
        key: "ANIMAL",
        topic: TOPICS.ANIMAL,
        isProperty: true,
        source: Object.freeze([
            Object.freeze({
                name: "VideoSourceConfigurationToken",
                type: "tt:ReferenceToken"
            })
        ]),
        data: Object.freeze([
            Object.freeze({
                name: "State",
                type: "xs:boolean"
            })
        ])
    }),
    Object.freeze({
        key: "PACKAGE",
        topic: TOPICS.PACKAGE,
        isProperty: true,
        source: Object.freeze([
            Object.freeze({
                name: "VideoSourceConfigurationToken",
                type: "tt:ReferenceToken"
            })
        ]),
        data: Object.freeze([
            Object.freeze({
                name: "State",
                type: "xs:boolean"
            })
        ])
    })
]);

const DEFAULT_TOPICS = Object.freeze(TOPIC_DEFINITIONS.map((definition) => definition.topic));

function getTopicDefinition(topic) {
    return TOPIC_DEFINITIONS.find((definition) => definition.topic === topic) || null;
}

module.exports = {
    TOPICS,
    TOPIC_DEFINITIONS,
    DEFAULT_TOPICS,
    getTopicDefinition
};
