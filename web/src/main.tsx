import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/almanac.css";
import "./styles/px.css";
import "./features/shell/shell.css";
import "./features/home/home.css";
import "./features/chat/chat.css";
import "./features/extras.css";
import "./styles/mobile.css";
// 桥接必须在老代码之前：老代码加载时就要读这些全局
import "./legacy/bridge";
import "virtual:legacy";
import { render } from "preact";
import { App } from "./app";
import { applyTheme } from "./stores/ui";
import { startRouter } from "./router";
import { startApp } from "./stores/boot";
import { startOverlaySync } from "./stores/overlays";
import { startRouteSync } from "./stores/routesync";

applyTheme();
startRouter();
startRouteSync();
startOverlaySync();
render(<App />, document.getElementById("app")!);
void startApp();
