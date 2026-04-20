import { SettingsNav } from "@/components/settings/SettingsNav";

export default function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <div>
        <h2 className="section-title">Settings</h2>
        <div className="section-sub">Integrations, stores, product COGS, rules &amp; alerts</div>
      </div>
      <div className="settings-shell">
        <SettingsNav />
        <div className="settings-content">{children}</div>
      </div>
    </>
  );
}
