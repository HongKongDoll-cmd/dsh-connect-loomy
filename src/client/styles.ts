export const LOOMY_CLIENT_CSS = `
.dsm-loomy-card {
  --dsm-loomy-surface: var(--dsw-alias-bg-layer-1, #17181b);
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font-size: 13px;
  line-height: 1.5;
}
.dsm-loomy-card input[type="checkbox"] {
  accent-color: var(--dsw-alias-brand-primary, #5686fe);
  cursor: pointer;
}
.dsm-loomy-page {
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
  padding: 20px 24px 40px;
  box-sizing: border-box;
  overflow-y: auto;
  max-height: 100%;
}
.dsm-loomy-page-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsm-loomy-page-head-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dsm-loomy-page-back {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-secondary, #c6c9d0);
  border-radius: 8px;
  padding: 5px 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  font-size: 13px;
  line-height: 20px;
}
.dsm-loomy-page-back:hover {
  color: var(--dsw-alias-label-primary, #e6e6e6);
  background: rgba(128, 128, 128, 0.14);
}
.dsm-loomy-panel-icon {
  border-radius: 4px;
  display: block;
}
.dsm-loomy-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsm-loomy-panels {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: stretch;
  gap: 2px;
  margin: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24));
  background: transparent;
}
.dsm-loomy-panel-tab {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 0;
  background: transparent;
  padding: 7px 12px;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  color: var(--dsw-alias-label-tertiary, #999);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}
.dsm-loomy-panel-tab:hover:not(.dsm-loomy-panel-tab-active) {
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.dsm-loomy-panel-tab-active {
  color: var(--dsw-alias-label-primary, #e6e6e6);
  border-bottom-color: var(--dsw-alias-brand-primary, #5686fe);
}
.dsm-loomy-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dsm-loomy-panel[hidden] {
  display: none;
}
.dsm-loomy-section {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.24));
  border-radius: 12px;
  padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.05));
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dsm-loomy-pool-modebar {
  padding: 14px 16px;
  gap: 12px;
  border: 1px solid rgba(86, 134, 254, 0.34);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(86, 134, 254, 0.09), rgba(86, 134, 254, 0.02)), var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.06));
  display: flex;
  flex-direction: column;
}
.dsm-loomy-switch-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dsm-loomy-switch-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.dsm-loomy-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  flex: none;
}
.dsm-loomy-switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.dsm-loomy-switch-track {
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.38);
  position: relative;
  transition: background-color 0.16s ease;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.dsm-loomy-switch-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.16s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
}
.dsm-loomy-switch input:checked + .dsm-loomy-switch-track {
  background: #4db8c4;
}
.dsm-loomy-switch input:checked + .dsm-loomy-switch-track::after {
  transform: translateX(16px);
}
.dsm-loomy-switch input:disabled + .dsm-loomy-switch-track {
  opacity: 0.55;
  cursor: not-allowed;
}
.dsm-loomy-switch-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.dsm-loomy-mode-pill {
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #c6c9d0);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.32));
  background: rgba(128, 128, 128, 0.1);
}
.dsm-loomy-switch-desc {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: #5ea3b5;
}
.dsm-loomy-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsm-loomy-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dsm-loomy-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.dsm-loomy-subtitle {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #9ea3ae);
}
.dsm-loomy-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsm-loomy-tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  padding-bottom: 8px;
  flex-wrap: wrap;
}
.dsm-loomy-tab {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9ea3ae);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.dsm-loomy-tab-active {
  color: var(--dsw-alias-label-primary, #e6e6e6);
  background: rgba(128, 128, 128, 0.14);
  border-color: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
}
.dsm-loomy-qr-box {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
}
.dsm-loomy-qr-img {
  width: 148px;
  height: 148px;
  border-radius: 8px;
  background: #fff;
  padding: 6px;
  object-fit: contain;
  border: 1px solid rgba(128, 128, 128, 0.2);
}
.dsm-loomy-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.32));
  background: transparent;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  border-radius: 7px;
  padding: 5px 11px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s, background-color 0.15s;
}
.dsm-loomy-btn-xs {
  padding: 3px 8px;
  font-size: 11px;
}
.dsm-loomy-btn:hover:not(:disabled) {
  background: rgba(128, 128, 128, 0.12);
}
.dsm-loomy-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dsm-loomy-btn-primary {
  background: var(--dsw-alias-label-primary, #e6e6e6);
  border-color: transparent;
  color: var(--dsw-alias-bg-layer-3, #17181b);
  font-weight: 600;
}
.dsm-loomy-btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  background: var(--dsw-alias-label-primary, #e6e6e6);
}
.dsm-loomy-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.dsm-loomy-badge-ok {
  color: var(--dsw-alias-state-success-primary, #22a06b);
  background: rgba(34, 160, 107, 0.14);
}
.dsm-loomy-badge-warn {
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
  background: rgba(245, 158, 11, 0.14);
}
.dsm-loomy-badge-err {
  color: var(--dsw-alias-state-error-primary, #ef4444);
  background: rgba(239, 68, 68, 0.14);
}
.dsm-loomy-badge-info {
  color: var(--dsw-alias-brand-primary, #5686fe);
  background: rgba(86, 134, 254, 0.14);
}
.dsm-loomy-badge-muted {
  color: var(--dsw-alias-label-secondary, #999);
  background: rgba(128, 128, 128, 0.14);
}
.dsm-loomy-credits-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.dsm-loomy-metric {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.2));
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.14));
}
.dsm-loomy-metric-label {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #9ea3ae);
}
.dsm-loomy-metric-val {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.dsm-loomy-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsm-loomy-input {
  flex: 1;
  min-width: 160px;
  padding: 6px 10px;
  font-size: 12px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.32));
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.18));
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.dsm-loomy-select {
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.32));
  background: var(--dsw-alias-bg-layer-3, #23252a);
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.dsm-loomy-table-wrap {
  overflow-x: auto;
}
.dsm-loomy-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.dsm-loomy-table th,
.dsm-loomy-table td {
  text-align: left;
  padding: 8px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.16));
  vertical-align: middle;
}
.dsm-loomy-table th {
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, #999);
  font-size: 11px;
}
.dsm-loomy-muted {
  color: var(--dsw-alias-label-secondary, #9ea3ae);
  font-size: 12px;
  line-height: 18px;
}
.dsm-loomy-error {
  color: var(--dsw-alias-state-error-primary, #ef4444);
  font-size: 12px;
}
.dsm-loomy-warn-box {
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
}
.dsm-loomy-notice {
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 12px;
  background: rgba(86, 134, 254, 0.1);
  border: 1px solid rgba(86, 134, 254, 0.28);
}
.dsm-loomy-ledger {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
}
.dsm-loomy-ledger-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.16));
}
.dsm-loomy-log-box {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.16));
}
.dsm-loomy-log-head {
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 500;
  background: rgba(128, 128, 128, 0.08);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.dsm-loomy-log-row {
  padding: 6px 12px;
  font-size: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.12));
  display: flex;
  gap: 10px;
}
.dsm-loomy-log-row:first-child {
  border-top: 0;
}
.dsm-loomy-diag {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  border-radius: 10px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.05));
}
.dsm-loomy-diag-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 14px;
}
.dsm-loomy-diag-row + .dsm-loomy-diag-row {
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
}
.dsm-loomy-diag-label {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #999);
  font-size: 12px;
}
.dsm-loomy-diag-value {
  min-width: 0;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font-size: 12px;
  text-align: right;
  overflow-wrap: anywhere;
}
.dsm-loomy-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dsm-loomy-prefs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px dashed var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.2));
}
.dsm-loomy-pref {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.dsm-loomy-pref input[type="checkbox"] {
  flex: none;
  margin: 3px 0 0;
  cursor: pointer;
  accent-color: var(--dsw-alias-brand-primary, #5686fe);
}
.dsm-loomy-pref-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.dsm-loomy-pref-label {
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.dsm-loomy-savebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.2));
}
.dsm-loomy-composer-wrap {
  display: inline-flex;
  align-items: center;
}
.dsm-loomy-pill {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-primary, rgba(128, 128, 128, 0.25));
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 12px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.dsm-loomy-pill:hover {
  color: var(--dsw-alias-label-primary, inherit);
  background: rgba(128, 128, 128, 0.1);
}
.dsm-loomy-popover {
  position: fixed;
  z-index: 9999;
  width: 340px;
  max-width: calc(100vw - 24px);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-elevated, #1e1e24);
  color: var(--dsw-alias-label-primary, #f5f5f5);
  border: 1px solid var(--dsw-alias-border-primary, rgba(128, 128, 128, 0.28));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.dsm-loomy-acct-row {
  appearance: none;
  width: 100%;
  text-align: left;
  background: transparent;
  color: inherit;
  border: 1px solid var(--dsw-alias-border-primary, rgba(128, 128, 128, 0.18));
  border-radius: 7px;
  padding: 6px 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
}
.dsm-loomy-acct-row:hover {
  background: rgba(128, 128, 128, 0.12);
}
.dsm-loomy-acct-row-active {
  border-color: var(--dsw-alias-brand-primary, #5686fe);
  background: rgba(86, 134, 254, 0.14);
}
`
