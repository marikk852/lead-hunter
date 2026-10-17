import { redirect } from "next/navigation";
import { isAuthenticated } from "@/src/auth/session";

export default async function Home() {
  redirect((await isAuthenticated()) ? "/dashboard" : "/login");
}
