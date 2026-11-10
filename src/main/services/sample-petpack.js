const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { importPetpack } = require("./petpack");

const SAMPLE_PETPACK_URL = "https://pet.zexu.dpdns.org/%E6%B7%98%E6%B7%98.petpack";

function toNodeReadable(body) {
  if (!body) {
    throw new Error("Sample petpack download returned an empty body");
  }

  if (typeof body.pipe === "function") {
    return body;
  }

  if (typeof Readable.fromWeb === "function" && typeof body.getReader === "function") {
    return Readable.fromWeb(body);
  }

  return Readable.from(body);
}

async function installSamplePetpack({
  fetchImpl,
  userDataDir,
  importPetpackImpl = importPetpack,
  sourceUrl = SAMPLE_PETPACK_URL,
  timeoutMs = 120000
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Sample petpack downloader is unavailable");
  }
  if (typeof userDataDir !== "string" || !userDataDir.trim()) {
    throw new TypeError("User data directory is required");
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "desktop-pet-sample-"));
  const tempPath = path.join(tempDir, "sample.petpack");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout.unref === "function") timeout.unref();

  try {
    const response = await fetchImpl(sourceUrl, { redirect: "follow", signal: controller.signal });
    if (!response || response.ok !== true) {
      const status = response && Number.isFinite(Number(response.status)) ? ` (${response.status})` : "";
      throw new Error(`Sample petpack download failed${status}`);
    }

    await pipeline(toNodeReadable(response.body), fs.createWriteStream(tempPath, { flags: "wx" }));
    return await importPetpackImpl(tempPath, userDataDir);
  } finally {
    clearTimeout(timeout);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  SAMPLE_PETPACK_URL,
  installSamplePetpack,
  toNodeReadable
};
