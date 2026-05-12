import semver from "semver";

interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_TOKEN: string;
}

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: GitHubAsset[];
}

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "sanum-updates-worker";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/update/")) return await handleCheck(url, env);
      if (url.pathname.startsWith("/download/")) return await handleDownload(url, env);
      return new Response("not found", { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`server error: ${msg}`, { status: 500 });
    }
  },
};

async function handleCheck(url: URL, env: Env): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "update") {
    return new Response("invalid update path", { status: 400 });
  }
  const [, target, arch, currentVersion] = parts;

  if (target !== "darwin") return new Response(null, { status: 204 });
  if (arch !== "aarch64" && arch !== "x86_64") return new Response(null, { status: 204 });

  const release = await fetchLatestRelease(env);
  const latestVersion = release.tag_name.replace(/^v/, "");

  if (!semver.valid(currentVersion) || !semver.valid(latestVersion)) {
    return new Response("invalid version", { status: 400 });
  }
  if (semver.lte(latestVersion, currentVersion)) {
    return new Response(null, { status: 204 });
  }

  // tauri-action emits macOS updater bundles as Sanum_<arch>.app.tar.gz
  // where arch is "aarch64" or "x64", and the matching signature has the
  // same name with .sig appended.
  const archSuffix = arch === "aarch64" ? "aarch64" : "x64";
  const tarballName = `Sanum_${archSuffix}.app.tar.gz`;
  const sigName = `${tarballName}.sig`;
  const tarball = release.assets.find((a) => a.name === tarballName);
  const sig = release.assets.find((a) => a.name === sigName);
  if (!tarball || !sig) {
    return new Response(`release missing ${tarballName} or ${sigName}`, { status: 502 });
  }

  const signature = await fetchAssetText(sig.id, env);
  const origin = `${url.protocol}//${url.host}`;

  return Response.json({
    version: latestVersion,
    pub_date: release.published_at,
    notes: release.body || release.name || `Version ${latestVersion}`,
    url: `${origin}/download/${tarball.id}`,
    signature,
  });
}

async function handleDownload(url: URL, env: Env): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "download") {
    return new Response("invalid download path", { status: 400 });
  }
  const assetId = parts[1];
  if (!/^\d+$/.test(assetId)) {
    return new Response("invalid asset id", { status: 400 });
  }

  // GitHub returns 302 to a presigned S3 URL. S3 rejects the request if our
  // Authorization header rides along, so handle the redirect manually and
  // re-fetch the Location without it.
  const initial = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${assetId}`,
    {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
    },
  );

  if (initial.status === 302) {
    const location = initial.headers.get("Location");
    if (!location) return new Response("missing redirect location", { status: 502 });
    const upstream = await fetch(location);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthroughHeaders(upstream.headers),
    });
  }

  if (initial.ok) {
    return new Response(initial.body, {
      status: initial.status,
      headers: passthroughHeaders(initial.headers),
    });
  }
  return new Response(`asset fetch failed: ${initial.status}`, { status: 502 });
}

async function fetchLatestRelease(env: Env): Promise<GitHubRelease> {
  const r = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": USER_AGENT,
      },
    },
  );
  if (!r.ok) {
    throw new Error(`GitHub releases/latest failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as GitHubRelease;
}

async function fetchAssetText(assetId: number, env: Env): Promise<string> {
  const initial = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/assets/${assetId}`,
    {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
    },
  );
  if (initial.status === 302) {
    const location = initial.headers.get("Location");
    if (!location) throw new Error("missing redirect location for sig");
    const upstream = await fetch(location);
    if (!upstream.ok) throw new Error(`s3 sig fetch failed: ${upstream.status}`);
    return (await upstream.text()).trim();
  }
  if (!initial.ok) throw new Error(`sig fetch failed: ${initial.status}`);
  return (await initial.text()).trim();
}

function passthroughHeaders(src: Headers): Headers {
  const out = new Headers();
  const ct = src.get("Content-Type");
  const cl = src.get("Content-Length");
  if (ct) out.set("Content-Type", ct);
  if (cl) out.set("Content-Length", cl);
  return out;
}
