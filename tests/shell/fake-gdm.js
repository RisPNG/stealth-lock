// Stand-in for GDM on the PRIVATE system bus (opt-in: SLH_FAKE_GDM=1).
// GNOME Shell creates Main.screenShield (the stock lock screen) only if org.gnome.DisplayManager.Manager reports a
// Version >= 3.5.91 on the system bus (js/misc/loginManager.js canLock()). This service answers just that, plus
// RegisterSession and the logind session/user interfaces consumed by ScreenShield and LoginManager.
// Authentication through GDM and suspend/inhibitor handling are not provided.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const address = GLib.getenv('DBUS_SYSTEM_BUS_ADDRESS');
if (!address || !address.startsWith(`unix:path=${GLib.getenv('SLH_ROOT')}/`))
    throw new Error('refusing to run outside the harness private system bus');

const connection = Gio.DBusConnection.new_for_address_sync(
    address,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
    null, null);

const xml = `<node><interface name="org.gnome.DisplayManager.Manager">
  <property name="Version" type="s" access="read"/>
  <method name="RegisterSession"><arg type="a{sv}" direction="in"/></method>
</interface></node>`;

const impl = {
    Version: '99.0',
    RegisterSession() {},
};
const exported = Gio.DBusExportedObject.wrapJSObject(xml, impl);
exported.export(connection, '/org/gnome/DisplayManager/Manager');
Gio.bus_own_name_on_connection(connection, 'org.gnome.DisplayManager', Gio.BusNameOwnerFlags.NONE, null, null);

const uid = new Gio.Credentials().get_unix_user();
const sessionId = 'stealth_harness';
const sessionPath = '/org/freedesktop/login1/session/stealth_harness';
const userPath = `/org/freedesktop/login1/user/_${uid}`;
const managerXml = `<node><interface name="org.freedesktop.login1.Manager">
  <method name="GetSession"><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
  <method name="GetUser"><arg type="u" direction="in"/><arg type="o" direction="out"/></method>
  <method name="ListSessions"><arg type="a(susso)" direction="out"/></method>
  <method name="CanSuspend"><arg type="s" direction="out"/></method>
  <method name="CanRebootToBootLoaderMenu"><arg type="s" direction="out"/></method>
  <signal name="PrepareForSleep"><arg type="b"/></signal>
  <signal name="SessionRemoved"><arg type="s"/><arg type="o"/></signal>
</interface></node>`;
const manager = Gio.DBusExportedObject.wrapJSObject(managerXml, {
    GetSession() {
        return sessionPath;
    },
    GetUser() {
        return userPath;
    },
    ListSessions() {
        return [[sessionId, uid, 'slh-nobody', 'seat0', sessionPath]];
    },
    CanSuspend() {
        return 'no';
    },
    CanRebootToBootLoaderMenu() {
        return 'no';
    },
});
manager.export(connection, '/org/freedesktop/login1');

const sessionXml = `<node><interface name="org.freedesktop.login1.Session">
  <property name="Id" type="s" access="read"/>
  <property name="Active" type="b" access="read"/>
  <property name="Class" type="s" access="read"/>
  <property name="Name" type="s" access="read"/>
  <property name="Remote" type="b" access="read"/>
  <property name="State" type="s" access="read"/>
  <property name="Type" type="s" access="read"/>
  <property name="LockedHint" type="b" access="read"/>
  <method name="SetLockedHint"><arg type="b" direction="in"/></method>
  <signal name="Lock"/>
  <signal name="Unlock"/>
</interface></node>`;
const sessionExports = [];
const session = {
    Id: sessionId,
    Active: true,
    Class: 'user',
    Name: 'slh-nobody',
    Remote: false,
    State: 'active',
    Type: 'wayland',
    LockedHint: false,
    SetLockedHint(locked) {
        this.LockedHint = locked;
        for (const object of sessionExports)
            object.emit_property_changed('LockedHint', new GLib.Variant('b', locked));
    },
};
for (const path of [sessionPath, '/org/freedesktop/login1/session/auto']) {
    const object = Gio.DBusExportedObject.wrapJSObject(sessionXml, session);
    object.export(connection, path);
    sessionExports.push(object);
}

const userXml = `<node><interface name="org.freedesktop.login1.User">
  <property name="Display" type="(so)" access="read"/>
  <property name="IdleHint" type="b" access="read"/>
  <property name="Sessions" type="a(so)" access="read"/>
  <property name="State" type="s" access="read"/>
</interface></node>`;
const user = Gio.DBusExportedObject.wrapJSObject(userXml, {
    Display: [sessionId, sessionPath],
    IdleHint: false,
    Sessions: [[sessionId, sessionPath]],
    State: 'active',
});
user.export(connection, userPath);
Gio.bus_own_name_on_connection(connection, 'org.freedesktop.login1', Gio.BusNameOwnerFlags.NONE, null, null);
new GLib.MainLoop(null, false).run();
