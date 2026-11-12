// 登录和首次创建管理员。盖在上面，不改网址；登录成功后撤掉，下面就是原来的地址。
import { useEffect, useRef, useState } from "preact/hooks";
import { enterApp } from "../../stores/boot";
import { lastUsername, loginError, setupMode, submitLogin } from "../../stores/auth";
import { toast } from "../../stores/ui";

export function Login() {
  const setup = setupMode.value;
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const user = useRef<HTMLInputElement>(null);
  const pwd = useRef<HTMLInputElement>(null);
  const pwd2 = useRef<HTMLInputElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const shown = err || loginError.value;

  useEffect(() => {
    // 有记住的用户名就直接聚焦密码框
    const t = setTimeout(() => (user.current?.value ? pwd.current : user.current)?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    setErr(""); loginError.value = "";
    setBusy(true);
    try {
      const u = await submitLogin({
        username: user.current!.value, password: pwd.current!.value,
        password2: pwd2.current?.value, displayName: name.current?.value,
      });
      if (pwd.current) pwd.current.value = "";
      if (pwd2.current) pwd2.current.value = "";
      enterApp(u);
      toast(`欢迎，${u.display_name}`, "ok");
    } catch (er) {
      setErr((er as Error).message);
      form.current?.animate([{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(8px)" }, { transform: "translateX(0)" }], { duration: 300 });
    } finally { setBusy(false); }
  };

  return (
    <div class="veil login-veil">
      <form class="login" ref={form} onSubmit={submit}>
        <div class="kicker"><span>Projector · 综合部工作台</span></div>
        <h3>{setup ? "创建管理员" : "欢迎回来"}</h3>
        <p class="sub">{setup ? "这个账号可以管理用户、聊天记录和技能库" : "用管理员给你的账号登录"}</p>
        {setup && <p class="hint">第一次使用：先创建管理员账号，之后在“管理后台”里给同事开账号。</p>}
        <label class="field"><span>用户名</span>
          <input class="input" ref={user} defaultValue={lastUsername()} autocomplete="username" required />
        </label>
        {setup && <label class="field"><span>显示的名字（可选）</span><input class="input" ref={name} /></label>}
        <label class="field"><span>密码</span>
          <input class="input" ref={pwd} type="password" autocomplete={setup ? "new-password" : "current-password"} required />
        </label>
        {setup && <label class="field"><span>再输一次密码</span><input class="input" ref={pwd2} type="password" /></label>}
        <div class="err" role="alert">{shown}</div>
        <button class="btn primary block" style="height:var(--hit)" disabled={busy}>{setup ? "创建并进入" : "登录"}</button>
        {!setup && <p class="ft">没有账号？请找管理员开通</p>}
      </form>
    </div>
  );
}
