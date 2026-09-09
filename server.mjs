// Painel de protótipos — descobre sozinho as pastas em Documents\ que têm um
// _serve.ps1, mostra se estão no ar e deixa subir/parar cada uma pelo clique.
// Node puro, sem dependências. Rodar: node server.mjs  (abre em http://localhost:8700/)

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { connect } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
// Os protótipos ficam nas pastas irmãs do painel, em Documents\prototipos\.
const DOCS_ROOT = dirname(HERE);
const PANEL_PORT = 8700;
const REGISTRY_PATH = join(HERE, "registry.json");
const MANUAL_PROJECTS_PATH = join(HERE, "projects.json");
const POWERSHELL_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const NPM_CMD = "C:\\node-v24.19.0-win-x64\\npm.cmd";

// ---------- descoberta ----------
// Auto: qualquer pasta direto em Documents\ com um _serve.ps1 (mesmo padrão dos
// protótipos estáticos: croqui-prototipo, osm-demo-prototipo, programador-prototipo).
// Manual (projects.json): protótipos que não seguem esse padrão — pasta aninhada,
// outro tipo de servidor (ex.: o "Radar de Editais", Next.js dentro do vault
// "Editais Licitacao", que sobe com "npm run dev", não com _serve.ps1). Adicionar
// uma entrada em projects.json quando o auto-descoberta não alcançar um novo protótipo.
function parsePort(serveScript) {
  const varMatch = serveScript.match(/\$port\s*=\s*(\d{3,5})/);
  if (varMatch) return Number(varMatch[1]);
  const litMatch = serveScript.match(/localhost:(\d{3,5})/);
  return litMatch ? Number(litMatch[1]) : null;
}

function parseTitle(dir) {
  try {
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const m = html.match(/<title>([^<]+)<\/title>/i);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

function loadManualProjects() {
  try { return JSON.parse(readFileSync(MANUAL_PROJECTS_PATH, "utf8")); } catch { return []; }
}

function discover() {
  const out = [];
  let entries;
  try { entries = readdirSync(DOCS_ROOT, { withFileTypes: true }); }
  catch (e) { entries = []; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(DOCS_ROOT, ent.name);
    const serveScript = join(dir, "_serve.ps1");
    if (!existsSync(serveScript)) continue;
    let port = null;
    try { port = parsePort(readFileSync(serveScript, "utf8")); } catch {}
    out.push({
      name: ent.name,
      path: dir,
      port,
      title: parseTitle(dir) || ent.name,
      kind: "serve-ps1",
    });
  }
  for (const m of loadManualProjects()) {
    if (out.some((p) => p.name === m.name)) continue; // auto-descoberta tem prioridade
    out.push({ name: m.name, path: m.path, port: m.port, title: m.title || m.name, kind: m.kind || "npm", startArgs: m.startArgs || ["run", "dev"] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- registro manual (deploy) ----------
function loadRegistry() {
  try { return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")); } catch { return {}; }
}
function saveRegistry(reg) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

// ---------- status de porta ----------
function checkPort(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = connect({ port, host: "127.0.0.1", timeout: 500 });
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
}

// ---------- processos que o próprio painel iniciou ----------
const tracked = new Map(); // name -> child process

// Windows/Node gotchas descobertos na prática, valem pros dois tipos de spawn abaixo:
// - "powershell"/"npm" sem extensão nem caminho completo dá ENOENT (Node não resolve
//   PATHEXT como um shell faria) — por isso os caminhos completos das constantes acima.
// - "detached: true" faz o Windows PowerShell sair na hora, código 0, sem saída nenhuma
//   (provável efeito de CREATE_NEW_PROCESS_GROUP sem console). Sem detached funciona normal
//   e o processo segue rodando independente da requisição HTTP que o disparou.
function startProject(name) {
  const proj = discover().find((p) => p.name === name);
  if (!proj) return { ok: false, error: "projeto não encontrado (foi renomeado ou removido?)" };
  if (tracked.has(name)) return { ok: true, already: true };

  // npm.cmd é um script, não um .exe — o Node recusa (EINVAL, síncrono) spawnar um .cmd
  // direto sem shell:true. serve-ps1 continua indo direto no .exe, sem shell.
  const isNpm = proj.kind === "npm";
  const cmd = isNpm ? NPM_CMD : POWERSHELL_EXE;
  const args = isNpm ? (proj.startArgs || ["run", "dev"]) : ["-ExecutionPolicy", "Bypass", "-File", "_serve.ps1"];

  let child;
  try {
    child = spawn(cmd, args, { cwd: proj.path, stdio: "ignore", windowsHide: true, shell: isNpm });
  } catch (err) {
    return { ok: false, error: `falha ao spawnar: ${err.message}` };
  }
  child.on("error", (err) => { tracked.delete(name); console.error(`[${name}] falhou ao iniciar:`, err.message); });
  child.on("exit", (code) => { tracked.delete(name); console.error(`[${name}] encerrou (código ${code})`); });
  child.unref();
  tracked.set(name, child);
  return { ok: true };
}

function stopProject(name) {
  const child = tracked.get(name);
  if (!child) return { ok: false, error: "esse servidor não foi iniciado por este painel — pare pelo terminal onde ele está rodando" };
  // child.kill() só derruba o processo de topo. Pro caso "npm" (shell:true → cmd.exe →
  // npm.cmd → next dev), o servidor de verdade é neto do processo rastreado e sobrevivia
  // ao kill simples, continuando de pé na porta. "taskkill /t" mata a árvore inteira.
  try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }); }
  catch { try { child.kill(); } catch {} }
  tracked.delete(name);
  return { ok: true };
}

// ---------- http ----------
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PANEL_PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = readFileSync(join(HERE, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const registry = loadRegistry();
    const projects = discover();
    const withStatus = await Promise.all(projects.map(async (p) => ({
      ...p,
      online: await checkPort(p.port),
      startedByPanel: tracked.has(p.name),
      deployUrl: registry[p.name]?.deployUrl || "",
      deployNote: registry[p.name]?.deployNote || "",
      gitRemote: registry[p.name]?.gitRemote || null,
    })));
    return json(res, 200, { panelPort: PANEL_PORT, docsRoot: DOCS_ROOT, projects: withStatus });
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    const { name } = await readBody(req);
    return json(res, 200, startProject(name));
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const { name } = await readBody(req);
    return json(res, 200, stopProject(name));
  }

  if (req.method === "POST" && url.pathname === "/api/registry") {
    const { name, deployUrl, deployNote } = await readBody(req);
    if (!name) return json(res, 400, { ok: false, error: "faltou o nome do projeto" });
    const registry = loadRegistry();
    registry[name] = { ...(registry[name] || {}), deployUrl: deployUrl ?? "", deployNote: deployNote ?? "" };
    saveRegistry(registry);
    return json(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("not found");
});

// rede de segurança: um spawn ruim já derrubou o painel inteiro uma vez (EINVAL síncrono
// de um .cmd sem shell:true) — não deixa uma falha de request matar o processo todo.
process.on("uncaughtException", (err) => console.error("erro não tratado (painel seguiu no ar):", err));

// só localhost — isto é um painel de admin pessoal, não deve ficar acessível na rede
server.listen(PANEL_PORT, "127.0.0.1", () => {
  console.log(`Painel de protótipos em http://localhost:${PANEL_PORT}/  (Ctrl+C para parar)`);
});
