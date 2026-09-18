const clientList = document.getElementById("client-list");
const offerClient = document.getElementById("offer-client");
const offerPrompt = document.getElementById("offer-prompt");
const offerSend = document.getElementById("offer-send");
const offerResult = document.getElementById("offer-result");
const timeline = document.getElementById("timeline");

const ONLINE_WINDOW_MS = 30_000;
const clients = new Map(); // clientId -> lastSeen

function renderClients() {
  clientList.replaceChildren();
  offerClient.replaceChildren();
  if (clients.size === 0) {
    const empty = document.createElement("li");
    empty.textContent = "（等待接入…）";
    clientList.append(empty);
    return;
  }
  for (const [clientId, lastSeen] of clients) {
    const online = Date.now() - lastSeen < ONLINE_WINDOW_MS;
    const item = document.createElement("li");
    item.textContent = `${clientId} · ${online ? "在线" : "心跳超时"}`;
    clientList.append(item);
    const option = document.createElement("option");
    option.value = clientId;
    option.textContent = clientId;
    offerClient.append(option);
  }
}

function appendTimeline(entry) {
  const item = document.createElement("li");
  const time = new Date(entry.at ?? Date.now()).toLocaleTimeString();
  item.textContent = `[${time}] ${entry.kind}${
    entry.clientId ? ` · ${entry.clientId}` : ""
  }${entry.targetClientId ? ` → ${entry.targetClientId}` : ""}`;
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

const source = new EventSource("/api/demo/observe");
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
