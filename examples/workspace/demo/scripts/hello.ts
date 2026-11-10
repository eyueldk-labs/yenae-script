import { defineScript, text, number, boolean, select, ask, show } from "yenae-script";

export default defineScript({
  name: "Hello",
  description: "Shows a form, asks questions while running and shows results.",
  icon: "message",
  params: {
    name: text().default("world"),
    times: number({ min: 1, max: 10 }).default(3),
    mood: select(["calm", "excited"]).default("calm"),
    shout: boolean().label("Shout"),
  },
  async run({ name, times, mood, shout }) {
    for (let i = 1; i <= times; i++) {
      console.log(`Hello ${name} (${i}/${times})`);
      await Bun.sleep(300);
    }
    const color = await ask.select("Favourite colour?", ["red", "green", "blue"]);
    if (!(await ask.confirm(`Show a table for ${color}?`, { default: true }))) return "Skipped the table";
    show.table([
      { name, mood, colour: color },
      { name: "you", mood: "curious", colour: "any" },
    ]);
    show.markdown(`## Done\nYou picked **${color}**.`);
    return shout ? `HELLO ${name.toUpperCase()}!` : `Hello ${name}.`;
  },
});
