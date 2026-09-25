import { Redirect } from "expo-router";
import { useSession } from "@/src/session";

export default function Index() {
  const { status } = useSession();
  if (status === "loading") return null;
  return <Redirect href={status === "signedIn" ? "/home" : "/login"} />;
}
