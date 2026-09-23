import Link from "next/link";

type WorkflowLink = { href: string; title: string; description: string };

export default function WorkflowLinks({ label, items }: { label: string; items: WorkflowLink[] }) {
  return <section className="workflow-links" aria-label={label}>{items.map(item => <Link href={item.href} key={item.href}>
    <div><h2>{item.title}</h2><p>{item.description}</p></div><span aria-hidden="true">↗</span>
  </Link>)}</section>;
}
