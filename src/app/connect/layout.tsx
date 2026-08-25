import { TopNav } from "@/components/TopNav";

export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="container">
      <TopNav />
      {children}
    </div>
  );
}
