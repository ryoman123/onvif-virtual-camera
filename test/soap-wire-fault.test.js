const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const soap = require("soap");

const faults = require("../src/onvif-fault");

const wsdl = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions
    xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
    xmlns:tns="urn:onvif-vcam:fault-test"
    xmlns:ter="http://www.onvif.org/ver10/error"
    targetNamespace="urn:onvif-vcam:fault-test">
  <wsdl:types>
    <xsd:schema targetNamespace="urn:onvif-vcam:fault-test" elementFormDefault="qualified">
      <xsd:element name="Ping">
        <xsd:complexType>
          <xsd:sequence/>
        </xsd:complexType>
      </xsd:element>
      <xsd:element name="PingResponse">
        <xsd:complexType>
          <xsd:sequence/>
        </xsd:complexType>
      </xsd:element>
    </xsd:schema>
  </wsdl:types>

  <wsdl:message name="PingRequest">
    <wsdl:part name="parameters" element="tns:Ping"/>
  </wsdl:message>
  <wsdl:message name="PingResponse">
    <wsdl:part name="parameters" element="tns:PingResponse"/>
  </wsdl:message>

  <wsdl:portType name="FaultPortType">
    <wsdl:operation name="Ping">
      <wsdl:input message="tns:PingRequest"/>
      <wsdl:output message="tns:PingResponse"/>
    </wsdl:operation>
  </wsdl:portType>

  <wsdl:binding name="FaultBinding" type="tns:FaultPortType">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Ping">
      <soap12:operation soapAction="urn:onvif-vcam:fault-test/Ping"/>
      <wsdl:input>
        <soap12:body use="literal"/>
      </wsdl:input>
      <wsdl:output>
        <soap12:body use="literal"/>
      </wsdl:output>
    </wsdl:operation>
  </wsdl:binding>

  <wsdl:service name="FaultService">
    <wsdl:port name="FaultPort" binding="tns:FaultBinding">
      <soap12:address location="http://127.0.0.1/fault"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

test("soap@1.1.5 serializes a two-level ONVIF SOAP 1.2 subcode chain", async () => {
    const server = http.createServer();

    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });

    soap.listen(server, {
        path: "/fault",
        services: {
            FaultService: {
                FaultPort: {
                    Ping() {
                        throw faults.noProfile();
                    }
                }
            }
        },
        xml: wsdl,
        forceSoap12Headers: true,
        callback(err) {
            if (err) {
                readyReject(err);
                return;
            }
            readyResolve();
        }
    });

    await new Promise((resolve, reject) => {
        server.listen(0, "127.0.0.1", (err) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });

    try {
        await ready;

        const address = server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}/fault`, {
            method: "POST",
            headers: {
                "content-type": 'application/soap+xml; charset=utf-8; action="urn:onvif-vcam:fault-test/Ping"'
            },
            body: `<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope
    xmlns:env="http://www.w3.org/2003/05/soap-envelope"
    xmlns:tns="urn:onvif-vcam:fault-test">
  <env:Body>
    <tns:Ping/>
  </env:Body>
</env:Envelope>`
        });

        const body = await response.text();

        assert.equal(response.status, 500);
        assert.match(body, /<soap:Value>soap:Sender<\/soap:Value>/);
        assert.match(body, /ter:InvalidArgVal/);
        assert.match(body, /ter:NoProfile/);
        assert.match(body, /xmlns:ter="http:\/\/www\.onvif\.org\/ver10\/error"/);

        const invalidArgPos = body.indexOf("ter:InvalidArgVal");
        const noProfilePos = body.indexOf("ter:NoProfile");
        assert.ok(invalidArgPos >= 0 && noProfilePos > invalidArgPos);

        const subcodeCount = (body.match(/<soap:Subcode>/g) || []).length;
        assert.equal(subcodeCount, 2);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
