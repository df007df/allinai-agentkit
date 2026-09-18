const clientList = document.getElementById("client-list");
const offerClient = document.getElementById("offer-client");
const offerPrompt = document.getElementById("offer-prompt");
const offerSend = document.getElementById("offer-send");
const offerResult = document.getElementById("offer-result");
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
      body: JSON.stringify({ clientId, prompt }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? response.status);
    offerResult.textContent = `已入队 offer ${payload.offerId}`;
  } catch (error) {
    offerResult.textContent = `派发失败：${error.message}`;
  }
  offerResult.hidden = false;
};

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
