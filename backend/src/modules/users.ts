/**
 * Usuários: login, cadastro (protegido), configurações e tokens de push.
 * Rotas montadas em /users.
 */
import bcrypt from "bcryptjs";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { authenticate, currentUser, exec, HttpError, parse, select, signToken } from "../core";

export const BCRYPT_ROUNDS = 12;
const DEFAULT_ICON_COLOR = "#255088";
// Hash descartável usado quando o e-mail não existe: mantém o tempo de resposta
// igual ao de senha incorreta e evita descobrir e-mails válidos por timing.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

const LoginSchema = z.object({
  email: z.string().trim().min(3, "Informe o e-mail").max(150),
  senha: z.string().min(1, "Informe a senha").max(200),
});

const CreateUserSchema = z.object({
  nome: z.string().trim().min(2, "Nome muito curto").max(100),
  email: z.email("E-mail inválido").max(150),
  senha: z.string().min(8, "A senha precisa ter ao menos 8 caracteres").max(200),
});

const ColorSchema = z.object({
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Cor inválida. Use formato HEX (#RRGGBB)."),
});
const DarkModeSchema = z.object({ enabled: z.boolean() });
const PushTokenSchema = z.object({
  expoPushToken: z
    .string()
    .max(255)
    .regex(/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/, "Token de push inválido"),
});

interface SettingsRow {
  icon_color: string | null;
  dark_mode: number | null;
  font_size: string | null;
}

export async function getSettings(userId: number) {
  const [row] = await select<SettingsRow>(
    "SELECT icon_color, dark_mode, font_size FROM user_settings WHERE user_id = ?",
    [userId],
  );
  return {
    iconColor: row?.icon_color ?? DEFAULT_ICON_COLOR,
    darkMode: row?.dark_mode === 1,
    fontSize: row?.font_size ?? "medium",
  };
}

export async function createUser(data: z.infer<typeof CreateUserSchema>) {
  const hash = await bcrypt.hash(data.senha, BCRYPT_ROUNDS);
  try {
    const result = await exec("INSERT INTO users (nome, email, senha_hash) VALUES (?, ?, ?)", [
      data.nome,
      data.email,
      hash,
    ]);
    return { id: result.insertId, nome: data.nome, email: data.email };
  } catch (err) {
    if ((err as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new HttpError(409, "Já existe um usuário com este e-mail", "DUPLICATE");
    }
    throw err;
  }
}

export const usersRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos.", code: "RATE_LIMIT" },
});

usersRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, senha } = parse(LoginSchema, req.body);

  const [user] = await select<{ id: number; email: string; nome: string; senha_hash: string }>(
    "SELECT id, email, nome, senha_hash FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  const ok = await bcrypt.compare(senha, user?.senha_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    throw new HttpError(401, "E-mail ou senha inválidos", "INVALID_CREDENTIALS");
  }

  const authUser = { id: user.id, email: user.email, nome: user.nome };
  req.log.info({ userId: user.id }, "Login realizado");
  res.json({ user: authUser, token: signToken(authUser), settings: await getSettings(user.id) });
});

// ---- Todas as rotas abaixo exigem autenticação ----
usersRouter.use(authenticate);

usersRouter.get("/", async (_req, res) => {
  res.json(await select("SELECT id, nome, email FROM users ORDER BY nome"));
});

usersRouter.post("/", async (req, res) => {
  const user = await createUser(parse(CreateUserSchema, req.body));
  req.log.info({ createdUserId: user.id, by: currentUser(req).id }, "Usuário criado");
  res.status(201).json(user);
});

usersRouter.get("/settings", async (req, res) => {
  res.json(await getSettings(currentUser(req).id));
});

usersRouter.put("/settings/icon-color", async (req, res) => {
  const { color } = parse(ColorSchema, req.body);
  await exec(
    `INSERT INTO user_settings (user_id, icon_color) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE icon_color = VALUES(icon_color)`,
    [currentUser(req).id, color],
  );
  res.json({ success: true, iconColor: color });
});

usersRouter.put("/settings/dark-mode", async (req, res) => {
  const { enabled } = parse(DarkModeSchema, req.body);
  await exec(
    `INSERT INTO user_settings (user_id, dark_mode) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE dark_mode = VALUES(dark_mode)`,
    [currentUser(req).id, enabled ? 1 : 0],
  );
  res.json({ success: true });
});

usersRouter.post("/push-token", async (req, res) => {
  const { expoPushToken } = parse(PushTokenSchema, req.body);
  await exec(
    `INSERT INTO user_push_tokens (user_id, expo_push_token) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE created_at = CURRENT_TIMESTAMP`,
    [currentUser(req).id, expoPushToken],
  );
  res.json({ success: true });
});

/** Chamado no logout: o aparelho deixa de receber push deste usuário. */
usersRouter.delete("/push-token", async (req, res) => {
  const { expoPushToken } = parse(PushTokenSchema, req.body);
  await exec("DELETE FROM user_push_tokens WHERE user_id = ? AND expo_push_token = ?", [
    currentUser(req).id,
    expoPushToken,
  ]);
  res.json({ success: true });
});
