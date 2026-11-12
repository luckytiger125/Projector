// 设置页签：权限档位（标准 / 严格）、同时运行的任务数、运行方式（cli / sdk）、标准档要确认的命令、严格档额外放行的命令。
import { useState } from "preact/hooks";
import { Icon } from "../../lib/icons";
import { saveSettings, settings } from "../../stores/admin";
import type { AdminSettings } from "../../stores/admin";
import { confirmBox, toast } from "../../stores/ui";

type ListKey = "ask_cmds" | "bash_allow";

function TagEditor({ k, st, hint }: { k: ListKey; st: AdminSettings; hint: string }) {
  const list = st[k];
  const [text, setText] = useState("");
  const save = async (next: string[]) => { await saveSettings({ [k]: next }); setText(""); };
  const reset = async () => {
    if (await confirmBox({ title: "恢复默认", message: "恢复成默认名单？", ok: "恢复默认" })) void save(k === "ask_cmds" ? st.default_ask : st.default_allow);
  };
  return (
    <>
      <div class="ad-tagbox">
        {list.map((c) => (
          <span key={c} class="chip"><span>{c}</span><button type="button" title="移除" aria-label="移除" onClick={() => void save(list.filter((x) => x !== c))}><Icon name="x" size={11} /></button></span>
        ))}
        <input placeholder={`${hint}，回车添加`} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.isComposing) return;
            const v = text.trim(); if (!v) return;
            void save([...list, v]);
          }} />
      </div>
      <div class="ad-acts"><button class="btn ghost sm" type="button" onClick={() => void reset()}>恢复默认</button></div>
    </>
  );
}

function Conc({ n }: { n: number }) {
  const [v, setV] = useState(String(n));
  const save = () => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1 || x > 16) { toast("请填 1 到 16 之间的整数", "err"); return; }
    void saveSettings({ max_concurrent: x });
  };
  return (
    <div class="ad-conc">
      <input class="input" type="number" min={1} max={16} value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      <button class="btn sm" type="button" onClick={save}>保存</button>
    </div>
  );
}

function Idle({ n }: { n: number }) {
  const [v, setV] = useState(String(n));
  const save = () => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 30 || x > 86400) { toast("请填 30 到 86400 之间的整数（秒）", "err"); return; }
    void saveSettings({ sdk_idle_seconds: x });
  };
  return (
    <div class="ad-conc">
      <input class="input" type="number" min={30} max={86400} value={v} aria-label="空闲多少秒后关闭" onInput={(e) => setV((e.target as HTMLInputElement).value)} />
      <button class="btn sm" type="button" onClick={save}>保存</button>
    </div>
  );
}

function Runner({ st }: { st: AdminSettings }) {
  const cur = st.runner_mode === "sdk" ? "sdk" : "cli";
  const pick = async (m: "cli" | "sdk") => {
    if (m === cur) return;
    if (m === "sdk") {
      const warn = st.sdk_available === false ? `\n\n现在还用不了：${st.sdk_error || "原因未知"}。切过去以后发消息会直接报错。` : "";
      if (!(await confirmBox({ title: "切到常驻会话", message: "常驻会话是新加的运行方式，还没有在所有环境里验证过。切换后对下一条消息生效，出问题可以随时切回来，不会丢会话。" + warn, ok: "切换" }))) return;
    }
    await saveSettings({ runner_mode: m });
  };
  return (
    <div class="ad-card">
      <h4 class="ad-h"><Icon name="terminal" size={16} />运行方式</h4>
      <div class="ad-desc">服务端怎样调用 Claude Code。两种方式下功能相同，会话通用，可以随时来回切。</div>
      <div class="ad-modes ad-runner">
        <button type="button" class={"ad-mode" + (cur === "cli" ? " on" : "")} aria-pressed={cur === "cli"} onClick={() => void pick("cli")}>
          <b><Icon name="terminal" size={17} />每轮启动（默认）</b>
          <p>每条消息启动一次 Claude，回答完就退出。一直在用的方式，最稳。</p>
        </button>
        <button type="button" class={"ad-mode" + (cur === "sdk" ? " on" : "")} aria-pressed={cur === "sdk"} onClick={() => void pick("sdk")}>
          <b><Icon name="bolt" size={17} />常驻会话（试用）</b>
          <p>每个会话保持一个 Claude 进程，同一会话后面的消息不用再等启动。需要先在台式机上装好依赖。</p>
        </button>
      </div>
      {st.sdk_available === false && (
        <div class={"ad-note" + (cur === "sdk" ? " err" : "")} role={cur === "sdk" ? "alert" : undefined}>
          <Icon name="alert" size={15} />
          <span>{cur === "sdk" ? "常驻会话现在用不了，发消息会报错，请先切回“每轮启动”：" : "常驻会话现在用不了："}{st.sdk_error || "原因未知"}</span>
        </div>
      )}
      {cur === "sdk" && (
        <>
          <div class="ad-desc ad-sub">空闲多久后关掉进程（秒，30~86400，默认 600）。关掉以后再发消息会重新启动并接上之前的内容。现在有 {st.sdk_clients ?? 0} 个常驻进程。</div>
          <Idle key={st.sdk_idle_seconds ?? 600} n={st.sdk_idle_seconds ?? 600} />
        </>
      )}
    </div>
  );
}

export function SettingsTab() {
  const st = settings.value;
  if (!st) return null;
  const mode = (m: string) => { if (st.perm_mode !== m) void saveSettings({ perm_mode: m }); };
  return (
    <>
      <h4 class="sk-h">权限档位 <span class="sk-hint">对所有人生效；“完全放行”在“用户”里按人开通</span></h4>
      <div class="ad-modes">
        <button type="button" class={"ad-mode" + (st.perm_mode === "standard" ? " on" : "")} onClick={() => mode("standard")}>
          <b><Icon name="bolt" size={17} />标准（推荐）</b>
          <p>读文件、改文件、运行 python / unzip 等命令都直接执行，只有删除、移动、格式化这类<b>危险命令</b>才弹确认。适合不懂技术的同事。</p>
        </button>
        <button type="button" class={"ad-mode" + (st.perm_mode === "strict" ? " on" : "")} onClick={() => mode("strict")}>
          <b><Icon name="shield" size={17} />严格</b>
          <p>只有 ls、cat 等只读命令和下面白名单里的命令自动执行，其他所有操作都要确认。</p>
        </button>
      </div>
      <div class="ad-card">
        <h4 class="ad-h"><Icon name="bolt" size={16} />同时运行的任务数</h4>
        <div class="ad-desc">台式机上最多同时跑几个 Claude。超过的消息会排队，前面的完成后按先后顺序自动开始（1~16，默认 3）。</div>
        <Conc key={st.max_concurrent} n={st.max_concurrent} />
      </div>
      {st.runner_mode !== undefined && <Runner st={st} />}
      {st.perm_mode === "standard" && (
        <div class="ad-card">
          <h4 class="ad-h"><Icon name="alert" size={16} />标准档：仍然要确认的命令</h4>
          <div class="ad-desc">命令以这些开头时会弹确认，比如写 <code>rm</code> 会拦住 <code>rm -rf 文件夹</code>。注意：用 python 脚本删文件这类间接操作拦不住。</div>
          <TagEditor k="ask_cmds" st={st} hint="比如 git push" />
        </div>
      )}
      {st.perm_mode === "strict" && (
        <div class="ad-card">
          <h4 class="ad-h"><Icon name="check" size={16} />严格档：额外自动放行的命令</h4>
          <div class="ad-desc">已默认放行：{st.safe.map((c) => <span key={c} class="ad-code"><code>{c}</code></span>)}</div>
          <TagEditor k="bash_allow" st={st} hint="比如 python" />
        </div>
      )}
    </>
  );
}
