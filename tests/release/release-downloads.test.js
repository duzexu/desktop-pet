import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");

function readProjectFile(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

describe("GitHub Release packaging", () => {
  test("uses stable macOS and Windows release asset names", () => {
    const config = readProjectFile("electron-builder.yml");

    expect(config).toContain("artifactName: Desktop-Pet-mac.${ext}");
    expect(config).toContain("artifactName: Desktop-Pet-windows.${ext}");
  });

  test("packages macOS as a status-bar application", () => {
    const config = readProjectFile("electron-builder.yml");
    const packageJson = JSON.parse(readProjectFile("package.json"));

    expect(config).toMatch(/extendInfo:\s*\n\s+LSUIElement: true/);
    expect(packageJson.build.mac.extendInfo).toEqual({ LSUIElement: true });
  });

  test("publishes both native installers after v tags", () => {
    const workflow = readProjectFile(".github/workflows/release.yml");

    expect(workflow).toContain("tags:");
    expect(workflow).toContain('- "v*"');
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("Desktop-Pet-mac.dmg");
    expect(workflow).toContain("Desktop-Pet-windows.exe");
    expect(workflow).toContain("--config electron-builder.yml");
    expect(workflow).toContain("softprops/action-gh-release@v2");
  });

  test("documents stable latest-version download links", () => {
    const readme = readProjectFile("README.md");

    expect(readme).toContain("releases/latest/download/Desktop-Pet-mac.dmg");
    expect(readme).toContain("releases/latest/download/Desktop-Pet-windows.exe");
    expect(readme).toContain("https://github.com/duzexu/desktop-pet/releases");
  });

  test("receives renderer-facing versions through sandbox-safe arguments", () => {
    const petPreload = readProjectFile("src/preload/pet-preload.js");
    const panelPreload = readProjectFile("src/preload/panel-preload.js");

    for (const preload of [petPreload, panelPreload]) {
      expect(preload).toContain('const VERSION_ARGUMENT_PREFIX = "--desktop-pet-version=";');
      expect(preload).toContain("process.argv.find");
      expect(preload).toMatch(/exposeInMainWorld\([\s\S]*?\{\s*version,/);
      expect(preload).not.toContain('require("../../package.json")');
      expect(preload).not.toMatch(/version:\s*["']\d+\.\d+\.\d+["']/);
    }
  });
});
