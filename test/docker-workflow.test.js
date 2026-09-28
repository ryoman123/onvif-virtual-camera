const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("production workflow publishes a commit-labelled immutable deployment image", () => {
    const workflow = fs.readFileSync(
        path.join(__dirname, "..", ".github", "workflows", "docker-build.yml"),
        "utf8"
    );

    assert.match(workflow, /id: build/);
    assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/);
    assert.match(workflow, /steps\.build\.outputs\.digest/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/onvif-virtual-camera@/);
});
