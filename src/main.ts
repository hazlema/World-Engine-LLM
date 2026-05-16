import * as readline from "readline";
import { loadStack, saveStack, WorldStack } from "./stack";
import { narratorTurn, archivistTurn } from "./engine";

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════╗
║           W O R L D  E N G I N E    ║
╚══════════════════════════════════════╝
`);
}

function printHelp(): void {
  console.log(`
  Commands:
    stack    show current world state
    threads  show active narrative threads
    reset    wipe the world and start over
    help     this message
    quit     suspend the world
`);
}

function printStack(stack: WorldStack): void {
  if (stack.entries.length === 0) {
    console.log("\n  (world stack is empty)\n");
  } else {
    console.log(`\n  World state — turn ${stack.turn}:`);
    stack.entries.forEach(e => console.log(`    · ${e.text}`));
    console.log();
  }
}

function printThreads(stack: WorldStack): void {
  if (stack.threads.length === 0) {
    console.log("\n  (no active threads — the world drifts)\n");
  } else {
    console.log(`\n  Active threads — turn ${stack.turn}:`);
    stack.threads.forEach(t => console.log(`    → ${t}`));
    console.log();
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let stack = await loadStack();

  printBanner();

  if (stack.turn === 0) {
    console.log("  The world is empty. What do you do?\n");
  } else {
    console.log(`  Resuming turn ${stack.turn}. ${stack.entries.length} facts, ${stack.threads.length} active threads.\n`);
  }

  const ask = () => {
    rl.question("> ", async (raw) => {
      const input = raw.trim();
      const cmd = input.toLowerCase();

      if (!cmd || cmd === "quit" || cmd === "exit") {
        console.log("\n  World suspended.\n");
        rl.close();
        return;
      }

      if (cmd === "help") { printHelp(); ask(); return; }
      if (cmd === "stack") { printStack(stack); ask(); return; }
      if (cmd === "threads") { printThreads(stack); ask(); return; }

      if (cmd === "reset") {
        const newStack: WorldStack = { entries: [], threads: [], turn: 0 };
        try {
          await saveStack(newStack);
          stack = newStack;
          console.log("\n  World reset. The void is empty again.\n");
        } catch (err) {
          console.error("\n  [reset failed — world not wiped]", err, "\n");
        }
        ask(); return;
      }

      process.stdout.write("\n");

      let narrative: string;
      try {
        narrative = await narratorTurn(stack, input);
        console.log("  " + narrative.replace(/\n/g, "\n  "));
        console.log();
      } catch (err) {
        console.error("\n  [narrator error]", err, "\n");
        ask();
        return;
      }

      try {
        stack = await archivistTurn(stack, narrative);
        await saveStack(stack);
      } catch (err) {
        console.warn("  [archivist failed — keeping old stack]", err);
      }

      ask();
    });
  };

  ask();
}

main();
