// Stand-in for GDM on the PRIVATE system bus (opt-in: SLH_FAKE_GDM=1).
// GNOME Shell creates Main.screenShield (the stock lock screen) only if org.gnome.DisplayManager.Manager reports a
// Version >= 3.5.91 on the system bus (js/misc/loginManager.js canLock()). This service answers just that, plus
// RegisterSession and the logind session/user interfaces consumed by ScreenShield and LoginManager.
// This fixture never authenticates a user or performs a host suspend operation.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const address = GLib.getenv('DBUS_SYSTEM_BUS_ADDRESS');
if (!address || !address.startsWith(`unix:path=${GLib.getenv('SLH_ROOT')}/`))
    throw new Error('refusing to run outside the harness private system bus');

const connection = Gio.DBusConnection.new_for_address_sync(
    address,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
    null, null);

const verifierXml = `<node><interface name="org.gnome.DisplayManager.UserVerifier">
  <method name="EnableExtensions"><arg type="as" direction="in"/></method>
  <method name="BeginVerification"><arg type="s" direction="in"/></method>
  <method name="BeginVerificationForUser"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <method name="AnswerQuery"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <method name="Cancel"/>
  <signal name="ConversationStarted"><arg type="s"/></signal>
  <signal name="ConversationStopped"><arg type="s"/></signal>
  <signal name="ReauthenticationStarted"><arg type="i"/></signal>
  <signal name="Info"><arg type="s"/><arg type="s"/></signal>
  <signal name="Problem"><arg type="s"/><arg type="s"/></signal>
  <signal name="InfoQuery"><arg type="s"/><arg type="s"/></signal>
  <signal name="SecretInfoQuery"><arg type="s"/><arg type="s"/></signal>
  <signal name="Reset"/>
  <signal name="ServiceUnavailable"><arg type="s"/><arg type="s"/></signal>
  <signal name="VerificationFailed"><arg type="s"/></signal>
  <signal name="VerificationComplete"><arg type="s"/></signal>
</interface></node>`;
const choiceXml = `<node><interface name="org.gnome.DisplayManager.UserVerifier.ChoiceList">
  <method name="SelectChoice"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="ChoiceQuery"><arg type="s"/><arg type="s"/><arg type="a{ss}"/></signal>
</interface></node>`;
const customXml = `<node><interface name="org.gnome.DisplayManager.UserVerifier.CustomJSON">
  <method name="Reply"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <method name="ReportError"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
  <signal name="Request"><arg type="s"/><arg type="s"/><arg type="u"/><arg type="s"/></signal>
</interface></node>`;
const peers = new Map();
const server = Gio.DBusServer.new_sync(`unix:tmpdir=${GLib.getenv('SLH_ROOT')}/run`,
    Gio.DBusServerFlags.AUTHENTICATION_REQUIRE_SAME_USER, Gio.dbus_generate_guid(), null, null);
server.connect('new-connection', (_server, peer) => {
    const extensions = new Map();
    let verifier;
    function beginVerification([service], invocation) {
        invocation.return_value(null);
        verifier.emit_signal('ConversationStarted', new GLib.Variant('(s)', [service]));
        verifier.emit_signal('SecretInfoQuery', new GLib.Variant('(ss)', [service, 'Password:']));
    }
    verifier = Gio.DBusExportedObject.wrapJSObject(verifierXml, {
        EnableExtensions(names) {
            for (const [name, xml, implementation] of [
                ['ChoiceList', choiceXml, {SelectChoice() {}}],
                ['CustomJSON', customXml, {Reply() {}, ReportError() {}}],
            ]) {
                if (names.includes(`org.gnome.DisplayManager.UserVerifier.${name}`) && !extensions.has(name)) {
                    const object = Gio.DBusExportedObject.wrapJSObject(xml, implementation);
                    object.export(peer, '/org/gnome/DisplayManager/Session');
                    extensions.set(name, object);
                }
            }
        },
        BeginVerificationAsync: beginVerification,
        BeginVerificationForUserAsync: beginVerification,
        AnswerQuery() {},
        CancelAsync(_parameters, invocation) {
            invocation.return_value(null);
            peer.flush(null, (connection, result) => {
                connection.flush_finish(result);
                connection.close(null, null);
            });
        },
    });
    verifier.export(peer, '/org/gnome/DisplayManager/Session');
    peers.set(peer, verifier);
    peer.connect('closed', () => {
        verifier.unexport();
        for (const object of extensions.values())
            object.unexport();
        peers.delete(peer);
    });
    return true;
});
server.start();

const xml = `<node><interface name="org.gnome.DisplayManager.Manager">
  <property name="Version" type="s" access="read"/>
  <method name="RegisterSession"><arg type="a{sv}" direction="in"/></method>
  <method name="OpenReauthenticationChannel"><arg type="s" direction="in"/><arg type="s" direction="out"/></method>
</interface></node>`;

const impl = {
    Version: '99.0',
    RegisterSession() {},
    OpenReauthenticationChannel() {
        return server.get_client_address();
    },
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
  <method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="h" direction="out"/></method>
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
    InhibitAsync(_parameters, invocation) {
        const file = Gio.File.new_for_path(`${GLib.getenv('SLH_ROOT')}/run/inhibit-${GLib.uuid_string_random()}`);
        const stream = file.create(Gio.FileCreateFlags.PRIVATE, null);
        const descriptors = Gio.UnixFDList.new();
        const handle = descriptors.append(stream.get_fd());
        file.delete(null);
        stream.close(null);
        invocation.return_value_with_unix_fd_list(new GLib.Variant('(h)', [handle]), descriptors);
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
const user = {
    Display: [sessionId, sessionPath],
    IdleHint: false,
    Sessions: [[sessionId, sessionPath]],
    State: 'active',
};
const userExports = [];
for (const path of [userPath, '/org/freedesktop/login1/user/self']) {
    const object = Gio.DBusExportedObject.wrapJSObject(userXml, user);
    object.export(connection, path);
    userExports.push(object);
}
Gio.bus_own_name_on_connection(connection, 'org.freedesktop.login1', Gio.BusNameOwnerFlags.NONE, null, null);
new GLib.MainLoop(null, false).run();
