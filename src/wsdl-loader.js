function stripXmlDeclaration(xml) {
    return String(xml).replace(/^\s*<\?xml[^>]*>\s*/i, "");
}

function extractSchemaDocument(xsdXml) {
    const withoutDeclaration = stripXmlDeclaration(xsdXml);
    const match = withoutDeclaration.match(/<xs:schema\b[\s\S]*<\/xs:schema>\s*$/i);

    if (!match) {
        throw new Error("types.xsd content does not contain a valid <xs:schema> document");
    }

    return match[0].trim();
}

function inlineTypesXsd(wsdlXml, xsdXml) {
    const schemaDocument = extractSchemaDocument(xsdXml);
    const importPattern = /<xs:import\b([^>]*)namespace=["']http:\/\/www\.onvif\.org\/ver10\/schema["']([^>]*)schemaLocation=["']types\.xsd["']([^>]*)\/>|<xs:import\b([^>]*)schemaLocation=["']types\.xsd["']([^>]*)namespace=["']http:\/\/www\.onvif\.org\/ver10\/schema["']([^>]*)\/>/i;

    const importMatch = String(wsdlXml).match(importPattern);
    if (!importMatch) {
        throw new Error("types.xsd import not found in WSDL");
    }

    const importWithoutLocation =
        '<xs:import namespace="http://www.onvif.org/ver10/schema"/>';

    let inlined = String(wsdlXml).replace(importPattern, importWithoutLocation);

    if (!/<\/wsdl:types>/i.test(inlined)) {
        throw new Error("WSDL does not contain a <wsdl:types> block");
    }

    inlined = inlined.replace(
        /<\/wsdl:types>/i,
        `${schemaDocument}\n    </wsdl:types>`
    );

    return inlined;
}

module.exports = {
    stripXmlDeclaration,
    extractSchemaDocument,
    inlineTypesXsd
};
