const clientList = document.getElementById("client-list");
const offerClient = document.getElementById("offer-client");
const offerRuntime = document.getElementById("offer-runtime");
const offerProject = document.getElementById("offer-project");
const offerPrompt = document.getElementById("offer-prompt");
const offerSend = document.getElementById("offer-send");
const offerResult = document.getElementById("offer-result");
const pluginClient = document.getElementById("plugin-client");
const pluginUrl = document.getElementById("plugin-url");
const pluginId = document.getElementById("plugin-id");
const pluginSyncBtn = document.getElementById("plugin-sync");
const pluginResult = document.getElementById("plugin-result");
const inventoryClient = document.getElementById("inventory-client");
const inventoryQueryBtn = document.getElementById("inventory-query");
const inventoryResult = document.getElementById("inventory-result");
const inventoryPlatforms = document.getElementById("inventory-platforms");
const inventoryPlugins = document.getElementById("inventory-plugins");
let lastInventoryClient = null;
const timeline = document.getElementById("timeline");
const sseStatus = document.getElementById("sse-status");

const ONLINE_WINDOW_MS = 30_000;
const clients = new Map(); // clientId -> lastSeen

function renderClients() {
  clientList.replaceChildren();
  offerClient.replaceChildren();
  if (clients.size === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "等待接入。先在终端执行左侧 login 与 daemon。";
    clientList.append(empty);
    return;
  }
  for (const [clientId, lastSeen] of clients) {
    const online = Date.now() - lastSeen < ONLINE_WINDOW_MS;
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = clientId;
    const state = document.createElement("span");
    state.className = online ? "state-on" : "state-off";
    state.textContent = online ? "在线" : "心跳超时";
    item.append(name, state);
    clientList.append(item);
    const option = document.createElement("option");
    option.value = clientId;
    option.textContent = clientId;
    offerClient.append(option);
    pluginClient.append(option.cloneNode(true));
    inventoryClient.append(option.cloneNode(true));
  }
}

function appendTimeline(entry) {
  const item = document.createElement("li");
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = `[${new Date(entry.at ?? Date.now()).toLocaleTimeString()}] `;
  item.append(time, document.createTextNode(entry.kind));
  if (entry.clientId) item.append(document.createTextNode(` · ${entry.clientId}`));
  if (entry.targetClientId)
    item.append(document.createTextNode(` → ${entry.targetClientId}`));
  timeline.prepend(item);
  while (timeline.children.length > 200) timeline.lastChild.remove();
}

offerSend.onclick = async () => {
  const clientId = offerClient.value;
  const prompt = offerPrompt.value.trim();
  const project = offerProject.value.trim();
  offerResult.hidden = true;
  if (!clientId || !prompt) {
    offerResult.textContent = "请选择 client 并输入 prompt";
    offerResult.hidden = false;
    return;
  }
  try {
    const response = await fetch("/api/demo/offers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        prompt,
        runtime: offerRuntime.value,
        ...(project ? { project } : {}),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? response.status);
    offerResult.textContent = `已入队 offer ${payload.offerId}（runtime=${offerRuntime.value}${project ? `，project=${project}` : ""}）`;
  } catch (error) {
    offerResult.textContent = `派发失败：${error.message}`;
  }
  offerResult.hidden = false;
};

pluginSyncBtn.onclick = async () => {
  const clientId = pluginClient.value;
  const gitUrl = pluginUrl.value.trim();
  const id = pluginId.value.trim();
  pluginResult.hidden = true;
  if (!clientId || !gitUrl || !id) {
    pluginResult.textContent = "请选择 client 并填写插件 ID 与 Git URL";
    pluginResult.hidden = false;
    return;
  }
  try {
    const response = await fetch("/api/demo/plugins/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        plugins: [{ id, gitUrl, enabled: true }],
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? response.status);
    pluginResult.textContent = payload.delivered
      ? "已推送 plugin.sync，等待 client 回执（见时间线 plugin.acknowledged）"
      : "client 当前不在线，未推送";
  } catch (error) {
    pluginResult.textContent = `推送失败：${error.message}`;
  }
  pluginResult.hidden = false;
};

inventoryQueryBtn.onclick = async () => {
  const clientId = inventoryClient.value;
  inventoryResult.hidden = true;
  if (!clientId) {
    inventoryResult.textContent = "请选择 client";
    inventoryResult.hidden = false;
    return;
  }
  try {
    const response = await fetch("/api/demo/inventory/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? response.status);
    inventoryResult.textContent = payload.delivered
      ? "已请求上报，等待 client 回传清单…"
      : "client 当前不在线，未请求";
  } catch (error) {
    inventoryResult.textContent = `请求失败：${error.message}`;
  }
  inventoryResult.hidden = false;
};

async function loadInventory(clientId) {
  const response = await fetch(`/api/demo/inventory/${encodeURIComponent(clientId)}`);
  if (!response.ok) return null;
  return response.json();
}

function renderInventory(report) {
  if (!report) {
    inventoryPlatforms.hidden = true;
    inventoryPlugins.hidden = true;
    inventoryResult.textContent = "该 client 尚未上报清单";
    inventoryResult.hidden = false;
    return;
  }
  inventoryResult.hidden = true;
  const pBody = inventoryPlatforms.querySelector("tbody");
  pBody.replaceChildren(
    ...report.platforms.map((p) => {
      const tr = document.createElement("tr");
      if (!p.installed) tr.className = "row-muted";
      tr.append(
        cell(p.platform), cell(p.installed ? "✓" : "✗"),
        cell(p.version ?? "-"), cell(p.reason ?? ""),
      );
      return tr;
    }),
  );
  inventoryPlatforms.hidden = false;
  const jBody = inventoryPlugins.querySelector("tbody");
  jBody.replaceChildren(
    ...report.plugins.map((j) => {
      const tr = document.createElement("tr");
      if (j.status === "failed") tr.className = "row-failed";
      tr.append(
        cell(j.id), cell(j.status), cell(j.enabled ? "✓" : "✗"),
        cell(j.resolvedCommit === "unresolved" ? "unresolved" : j.resolvedCommit.slice(0, 7)),
        cell(j.ref ?? "-"),
      );
      return tr;
    }),
  );
  inventoryPlugins.hidden = false;
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = String(text ?? "");
  return td;
}

function setSseState(state, label) {
  sseStatus.dataset.state = state;
  sseStatus.textContent = label;
}

const source = new EventSource("/api/demo/observe");
source.onopen = () => setSseState("online", "观测流已连接");
source.onerror = () => setSseState("offline", "观测流已断开，自动重连中");

source.addEventListener("snapshot", (event) => {
  const snapshot = JSON.parse(event.data);
  if (snapshot.warning) {
    const node = document.getElementById("host-warning");
    node.textContent = snapshot.warning;
    node.hidden = false;
  }
  for (const client of snapshot.clients ?? []) {
    clients.set(client.clientId, client.lastSeen);
  }
  renderClients();
});
source.addEventListener("observation", (event) => {
  const observation = JSON.parse(event.data);
  if ("clientId" in observation && observation.clientId) {
    clients.set(observation.clientId, Date.now());
  }
  if (observation.kind === "inventory.recorded") {
    const clientId = observation.clientId;
    lastInventoryClient = clientId;
    if (clientId === inventoryClient.value || !inventoryClient.value) {
      loadInventory(clientId).then((report) => {
        if (report) renderInventory(report);
      });
    }
  }
  appendTimeline(observation);
  renderClients();
});
setInterval(renderClients, 5_000);

/* 终端块复制按钮 */
const copyBtn = document.querySelector("[data-copy]");
if (copyBtn) {
  copyBtn.onclick = async () => {
    const code = document.querySelector(".term-body code");
    await navigator.clipboard.writeText(code.textContent);
    copyBtn.textContent = "已复制";
    setTimeout(() => {
      copyBtn.textContent = "复制全部";
    }, 1500);
  };
}
