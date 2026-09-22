/* 渐进增强：把 docs.html 的 <pre class="code-block"> 包成 IDE 窗口壳。
 * 零依赖；无 JS 时代码块仍按原样式展示。每块只处理一次（data-ide-done）。 */
(function () {
  "use strict";

  var nextFileNo = 1;

  function guessName(pre) {
    var text = pre.textContent;
    // shell 片段：命令行开头
    if (/^\s*(npx|npm|sh|git|node|allinai-agentkit)\b/.test(text) && !/[{;]/.test(text.split("\n")[0] + text.split("\n")[1])) {
      return "terminal.sh";
    }
    if (/import\s+.*from\s+"@allin-ai\/agentkit\/console(-ui)?"/.test(text)) return "console.ts";
    if (/createMemoryHub/.test(text)) return "memory-hub.ts";
    if (/HubStore\s*<|implements HubStore/.test(text)) return "store.ts";
    if (/ClientSupervisor|WsClientTransport/.test(text)) return "supervisor.ts";
    if (/createAgentControlClient/.test(text)) return "control.ts";
    if (/startConsoleServer/.test(text)) return "console.ts";
    if (/createAgentHub/.test(text)) return "hub.ts";
    if (/\ next|NextJS|next\(/.test(text)) return "server.ts";
    return "snippet-" + nextFileNo++ + ".ts";
  }

  function isShell(name) {
    return name === "terminal.sh";
  }

  /* 轻量着色：只处理注释、字符串与关键字，输入是已转义的 HTML 文本。
   * 用占位符保护已着色片段，避免二次替换。 */
  function highlight(escaped, shell) {
    var store = [];
    function put(html) {
      store.push(html);
      return "\u0000" + (store.length - 1) + "\u0000";
    }
    var out = escaped
      // 注释整行/行尾（.c span 已由源码标注，或 shell 的 # 注释）
      .replace(/(<span class="c">[\s\S]*?<\/span>)/g, function (m) { return put(m); })
      .replace(/(^|\n)(\s*#[^\n]*)/g, function (m, nl, c) { return nl + put('<span class="c">' + c + "</span>"); })
      // 字符串
      .replace(/(&quot;[^&]*?&quot;|"[^"\n]*")/g, function (m) { return put('<span class="ide-str">' + m + "</span>"); })
      // 关键字（词边界，避免命中标识符片段）
      .replace(/\b(import|from|const|await|async|export|function|return|new|class|extends|implements|type|interface)\b/g, function (m) {
        return put('<span class="ide-kw">' + m + "</span>");
      });
    return out.replace(/\u0000(\d+)\u0000/g, function (_, i) { return store[+i]; });
  }

  function enhance(pre) {
    if (pre.dataset.ideDone) return;
    pre.dataset.ideDone = "1";

    var code = pre.querySelector("code");
    if (!code) return;

    var name = guessName(pre);
    var shell = isShell(name);
    var lines = code.innerHTML.split("\n");

    var wrapper = document.createElement("div");
    wrapper.className = "ide ide-block" + (shell ? " ide-shell" : "");

    var bar = document.createElement("div");
    bar.className = "ide-titlebar";
    bar.innerHTML =
      '<span class="ide-dot r"></span><span class="ide-dot y"></span><span class="ide-dot g"></span>' +
      '<span class="ide-file"></span>';
    bar.querySelector(".ide-file").textContent = name;

    var body = document.createElement("pre");
    body.className = "ide-code";

    var gutterPad = String(lines.length).length;
    var html = lines
      .map(function (line, i) {
        var no = String(i + 1).padStart(gutterPad, " ");
        return (
          '<span class="ln">' + no + "</span>" +
          (line === "" ? " " : highlight(line, shell))
        );
      })
      .join("\n");
    body.innerHTML = "<code>" + html + "</code>";

    pre.replaceWith(wrapper);
    wrapper.appendChild(bar);
    wrapper.appendChild(body);
  }

  function run() {
    document.querySelectorAll("pre.code-block").forEach(enhance);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
