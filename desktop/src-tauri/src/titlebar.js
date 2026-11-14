// 自绘顶栏：Windows 上窗口去掉了系统标题栏，由这段脚本在每个页面顶上画一条（设置页和服务器网页都会注入）。
// 自带样式，不依赖页面；页面通过 --titlebar-h 这个变量知道要让出多高。
(function () {
  if (window.top !== window || !/Windows/.test(navigator.userAgent)) return;
  var H = 32;
  var ICONS = {
    min: '<path d="M0 5.5h10"/>',
    max: '<path d="M.5.5h9v9h-9z"/>',
    restore: '<path d="M2.5 2.5v-2h7v7h-2M.5 2.5h7v7h-7z"/>',
    close: '<path d="M0 0l10 10M10 0L0 10"/>',
  };
  var CSS =
    "html.pj-frameless{--titlebar-h:" + H + "px}" +
    "html.pj-frameless body{box-sizing:border-box!important;height:calc(100% - " + H + "px)!important;margin-top:" + H + "px!important}" +
    "#pj-titlebar{position:fixed;top:0;left:0;right:0;height:" + H + "px;z-index:2147483647;display:flex;align-items:stretch;" +
    "background:#131F31;color:rgba(242,234,214,.62);font:600 12px/" + H + "px 'Songti SC','Noto Serif CJK SC','SimSun',serif;" +
    "letter-spacing:.24em;user-select:none;-webkit-user-select:none;cursor:default}" +
    "#pj-titlebar .pj-title{flex:1;min-width:0;padding-left:14px;overflow:hidden;white-space:nowrap}" +
    "#pj-titlebar button{all:unset;box-sizing:border-box;width:46px;height:" + H + "px;display:grid;place-items:center;color:rgba(242,234,214,.72);transition:background .12s,color .12s}" +
    "#pj-titlebar button:hover{background:rgba(242,234,214,.10);color:#F2EAD6}" +
    "#pj-titlebar button.pj-close:hover{background:#C4452F;color:#fff}" +
    "#pj-titlebar svg{width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:1;overflow:visible;pointer-events:none}";

  function win() {
    var t = window.__TAURI__;
    return t && t.window && t.window.getCurrentWindow ? t.window.getCurrentWindow() : null;
  }
  function call(name) {
    var w = win();
    if (!w) return Promise.resolve();
    return Promise.resolve(w[name]()).catch(function () {});
  }
  function icon(name) {
    return '<svg viewBox="0 0 10 10" aria-hidden="true">' + ICONS[name] + "</svg>";
  }

  function build() {
    if (document.getElementById("pj-titlebar")) return;
    document.documentElement.classList.add("pj-frameless");
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    var bar = document.createElement("div");
    bar.id = "pj-titlebar";
    var title = document.createElement("div");
    title.className = "pj-title";
    title.textContent = "综合部工作台";
    bar.appendChild(title);

    var maxBtn;
    [["min", "最小化", "minimize"], ["max", "最大化", "toggleMaximize"], ["close", "关闭", "close"]].forEach(function (b) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pj-" + b[0];
      btn.title = b[1];
      btn.setAttribute("aria-label", b[1]);
      btn.innerHTML = icon(b[0]);
      btn.addEventListener("click", function () { call(b[2]); });
      bar.appendChild(btn);
      if (b[0] === "max") maxBtn = btn;
    });

    // 按住空白处拖动窗口，双击最大化/还原
    bar.addEventListener("mousedown", function (e) {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      call(e.detail === 2 ? "toggleMaximize" : "startDragging");
    });

    function syncMax() {
      var w = win();
      if (!w) return;
      Promise.resolve(w.isMaximized()).then(function (on) {
        maxBtn.innerHTML = icon(on ? "restore" : "max");
        maxBtn.title = on ? "还原" : "最大化";
        maxBtn.setAttribute("aria-label", maxBtn.title);
      }).catch(function () {});
    }
    window.addEventListener("resize", syncMax);
    syncMax();
    document.body.appendChild(bar);
  }

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
})();
