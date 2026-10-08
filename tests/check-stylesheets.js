import Gio from 'gi://Gio';
import St from 'gi://St';

const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
for (const name of ['stylesheet.css', 'styles/stylesheet-base.css', 'stylesheet-dark.css', 'stylesheet-light.css']) {
    const file = root.resolve_relative_path(name);
    new St.Theme().load_stylesheet(file);
    const source = new TextDecoder().decode(file.load_contents(null)[1]);
    for (const [, target] of source.matchAll(/@import\s+url\("([^"]+)"\)/g)) {
        if (!file.get_parent().resolve_relative_path(target).query_exists(null))
            throw new Error(`${name}: missing imported stylesheet ${target}`);
    }
}
console.log('Native St stylesheet parser passed all four stylesheets');
