// @ts-nocheck
/* Bee Code Skills & MCP library view. Plain webview JS. */
const vscode = acquireVsCodeApi();
const post = (message) => vscode.postMessage(message);
const skillsEl = document.getElementById("skills");
const mcpEl = document.getElementById("mcp");
const skillDrop = document.getElementById("skill-drop");
const mcpDrop = document.getElementById("mcp-drop");

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function filesFromEntries(entries, prefix = "") {
  const out = [];
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ path: prefix + file.name, data: await readAsBase64(file) });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await new Promise((resolve) => reader.readEntries(resolve));
      out.push(...(await filesFromEntries(children, prefix + entry.name + "/")));
    }
  }
  return out;
}

async function filesFromFileList(files) {
  const out = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    out.push({ path, data: await readAsBase64(file) });
  }
  return out;
}

function setupDrop(zone, handler) {
  zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    zone.classList.remove("over");
    const uriList = event.dataTransfer.getData("text/uri-list");
    if (uriList) {
      post({ type: "dropUris", files: uriList.split(/\r?\n/).filter((line) => line && !line.startsWith("#")) });
      return;
    }
    const items = Array.from(event.dataTransfer.items || []);
    if (items.length && typeof items[0].webkitGetAsEntry === "function") {
      const entries = items.map((item) => item.webkitGetAsEntry()).filter(Boolean);
      if (entries.length) {
        await handler(await filesFromEntries(entries));
        return;
      }
    }
    await handler(await filesFromFileList(event.dataTransfer.files || []));
  });
}

setupDrop(skillDrop, (files) => {
  if (files.length) post({ type: "addSkillFiles", files });
});
setupDrop(mcpDrop, async (files) => {
  const configs = [];
  for (const file of files) {
    if (!/\.json$/i.test(file.path)) continue;
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    configs.push({ name: file.path.split("/").pop() || "mcp.json", text });
  }
  if (configs.length) post({ type: "addMcpFile", files: configs });
});

document.getElementById("add-skill").addEventListener("click", () => post({ type: "addSkillFolder" }));
document.getElementById("add-mcp").addEventListener("click", () => post({ type: "addMcpFile", files: [] }));
document.getElementById("refresh").addEventListener("click", () => post({ type: "refresh" }));

window.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type !== "state") return;
  const state = msg.state || {};
  skillsEl.innerHTML = "";
  for (const skill of state.skills || []) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(skill.name)}</strong><span>${escapeHtml(skill.description || "")}</span><button data-skill="${escapeHtml(skill.name)}">Remove</button>`;
    skillsEl.appendChild(li);
  }
  mcpEl.innerHTML = "";
  for (const server of state.mcp || []) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(server.name)}</strong><span>${escapeHtml(server.command)} ${escapeHtml((server.args || []).join(" "))}</span><button data-mcp="${escapeHtml(server.name)}">Remove</button>`;
    mcpEl.appendChild(li);
  }
  skillsEl.querySelectorAll("button[data-skill]").forEach((button) => {
    button.addEventListener("click", () => post({ type: "removeSkill", name: button.getAttribute("data-skill") }));
  });
  mcpEl.querySelectorAll("button[data-mcp]").forEach((button) => {
    button.addEventListener("click", () => post({ type: "removeMcp", name: button.getAttribute("data-mcp") }));
  });
});
