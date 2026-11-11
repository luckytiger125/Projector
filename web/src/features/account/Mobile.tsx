// 在手机上打开：局域网地址的二维码。网址 /mobile，数据在 stores/mobile.ts。
import { Sheet } from "../../components/Sheet";
import { orb } from "../../lib/avatars";
import { Icon } from "../../lib/icons";
import { closeOverlay, overlayRoute } from "../../router";
import { me } from "../../stores/auth";
import { picked, pick, qrSvg, ready, urls } from "../../stores/mobile";
import { toast } from "../../stores/ui";

export function MobileSheet() {
  const r = overlayRoute.value;
  if (!r || r.name !== "mobile" || !me.value) return null;
  const list = urls.value;
  const copy = () => { void navigator.clipboard?.writeText(picked.value).then(() => toast("已复制", "ok", 1500)); };
  return (
    <Sheet class="ac compact" kicker="Projector · 综合部工作台" title="在手机上打开" onClose={() => closeOverlay()}>
      <div class="pane">
        {!ready.value ? <div class="empty">读取中…</div> : (
          <div class="ac-qr">
            <div class="ac-qrcard">
              <span dangerouslySetInnerHTML={{ __html: qrSvg.value }} />
              <span class="ac-orb" dangerouslySetInnerHTML={{ __html: orb(46) }} />
            </div>
            <div class="ac-qrurl"><span>{picked.value}</span><button class="icon-btn" type="button" title="复制" aria-label="复制" onClick={copy}><Icon name="copy" size={16} /></button></div>
            {list.length > 1 && (
              <div class="ac-seg">
                {list.map((u) => <button key={u} type="button" class={u === picked.value ? "on" : ""} onClick={() => pick(u)}>{u.replace(/^https?:\/\//, "")}</button>)}
              </div>
            )}
            <p class="ac-wifi">手机连上和这台台式机<b>同一个 Wi-Fi</b>，用相机或微信扫一扫。</p>
            <div class="ac-steps">
              <div><b>iPhone</b>用 Safari 打开 → 底部分享按钮 → “添加到主屏幕”，之后像 App 一样全屏打开</div>
              <div><b>安卓</b>用 Chrome 打开 → 右上角 ⋮ → “添加到主屏幕”，桌面上会出现橙光球图标</div>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
