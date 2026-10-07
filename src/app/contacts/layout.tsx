import { TopNav } from "@/components/TopNav";

export default function ContactsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="container">
      <TopNav />
      {children}
    </div>
  );
}
