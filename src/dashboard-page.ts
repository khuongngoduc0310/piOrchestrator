import { DASHBOARD_CLIENT_AGENT } from "./dashboard-client-agent.js";
import { DASHBOARD_CLIENT_CORE } from "./dashboard-client-core.js";
import { DASHBOARD_CLIENT_RUNTIME } from "./dashboard-client-runtime.js";
import {
  DASHBOARD_DOCUMENT_END,
  DASHBOARD_DOCUMENT_START,
  DASHBOARD_MARKUP,
} from "./dashboard-markup.js";
import { DASHBOARD_STYLES } from "./dashboard-styles.js";
import { UI_PHASE_LABELS } from "./types.js";

const PHASES_JSON = JSON.stringify(UI_PHASE_LABELS);

export const DASHBOARD_HTML =
  DASHBOARD_DOCUMENT_START +
  DASHBOARD_STYLES +
  DASHBOARD_MARKUP +
  `var PHASES = ${PHASES_JSON};` +
  DASHBOARD_CLIENT_CORE +
  DASHBOARD_CLIENT_AGENT +
  DASHBOARD_CLIENT_RUNTIME +
  DASHBOARD_DOCUMENT_END;
