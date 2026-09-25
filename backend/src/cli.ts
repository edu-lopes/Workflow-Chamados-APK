/**
 * Utilitários administrativos (rodar no servidor):
 *   node --env-file=.env dist/cli.js create-user "Nome Completo" email@empresa.com.br
 *   node --env-file=.env dist/cli.js set-password email@empresa.com.br
 *   node --env-file=.env dist/cli.js list-users
 * A senha é pedida no terminal (não fica no histórico do shell).
 */
import bcrypt from "bcryptjs";
import { createInterface } from "node:readline";
import { exec, pool, select } from "./core";
import { BCRYPT_ROUNDS, createUser } from "./modules/users";

/** Pergunta a senha duas vezes sem ecoar no terminal (também aceita stdin via pipe). */
async function askPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  // Silencia o eco das teclas; os prompts são escritos manualmente
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string) => {
    process.stdout.write(q);
    const { value } = await lines.next();
    process.stdout.write("\n");
    return String(value ?? "");
  };
  try {
    const p1 = await ask("Senha (mín. 8 caracteres): ");
    const p2 = await ask("Confirme a senha: ");
    if (p1 !== p2) throw new Error("As senhas não conferem");
    if (p1.length < 8) throw new Error("A senha precisa ter ao menos 8 caracteres");
    return p1;
  } finally {
    rl.close();
  }
}

async function run() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "create-user": {
      const [nome, email] = args;
      if (!nome || !email) throw new Error('Uso: create-user "Nome" email@dominio');
      const user = await createUser({ nome, email, senha: await askPassword() });
      console.log(`Usuário criado: #${user.id} ${user.nome} <${user.email}>`);
      break;
    }
    case "set-password": {
      const [email] = args;
      if (!email) throw new Error("Uso: set-password email@dominio");
      const hash = await bcrypt.hash(await askPassword(), BCRYPT_ROUNDS);
      const result = await exec("UPDATE users SET senha_hash = ? WHERE email = ?", [hash, email]);
      console.log(result.affectedRows ? "Senha atualizada." : "Usuário não encontrado.");
      break;
    }
    case "list-users": {
      console.table(await select("SELECT id, nome, email FROM users ORDER BY id"));
      break;
    }
    default:
      console.log("Comandos: create-user <nome> <email> | set-password <email> | list-users");
  }
}

run()
  .catch((err) => {
    console.error("Erro:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
