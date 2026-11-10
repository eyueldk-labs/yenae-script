import { defineScript, text, folder, show } from "yenae-script";
import { extensionFiles, checkTarget, mirror } from "../lib/mirror";

export default defineScript({
  name: "Update unpacked extension",
  description: "Download an extension zip and mirror it into its unpacked folder.",
  params: {
    zipUrl: text({ placeholder: "https://example.com/extension.zip" }).label("Zip URL"),
    target: folder().label("Extension folder"),
  },
  schedule: { every: "10m" },
  async run({ zipUrl, target }) {
    console.log(`Downloading ${zipUrl}`);
    const res = await fetch(zipUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    const zip = new Uint8Array(await res.arrayBuffer());

    const { files, manifest } = extensionFiles(zip);
    const current = checkTarget(target, manifest);
    console.log(
      current
        ? `Folder has ${current.name} ${current.version}; zip has ${manifest.version}`
        : `Folder is new or empty; installing ${manifest.name} ${manifest.version}`,
    );

    const { written, removed } = mirror(target, files);
    for (const r of removed) console.log(`Removed ${r}`);
    show.markdown(
      `**${manifest.name}** ${current?.version && current.version !== manifest.version ? `${current.version} → ` : ""}${manifest.version}  \n` +
        `${written} files copied, ${removed.length} removed. Reload the extension in chrome://extensions to apply.`,
    );
  },
});
