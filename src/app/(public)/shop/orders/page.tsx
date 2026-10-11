"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Info } from "lucide-react";
import { MyOrders } from "@/components/my-orders";
import { useVisitor } from "@/components/public-shell";
import { Card, LinkButton, LoadingBlock, Notice, PageHeader } from "@/components/ui";
import { shopperMember } from "@/lib/contracts";

/**
 * Merchandise orders for a committee account that shops as the member it is
 * linked to. (The member area is not open to committee accounts.) A member is
 * sent to their own orders page; anyone else is told why there is nothing here.
 */
export default function ShopOrdersPage() {
  const visitor = useVisitor();
  const router = useRouter();
  const isMember = visitor?.role === "member";

  useEffect(() => {
    if (isMember) router.replace("/member/orders");
  }, [isMember, router]);

  if (visitor === undefined || isMember) {
    return (
      <Card>
        <LoadingBlock label="Loading your orders" />
      </Card>
    );
  }
  if (shopperMember(visitor)) return <MyOrders />;
  return (
    <>
      <PageHeader title="My orders" />
      <Notice tone="neutral" icon={Info}>
        {visitor === null
          ? "Sign in with your member account to see your orders."
          : "Your committee account is not linked to a member record, so it has no order history here. Orders you place as a guest are paid to the committee when you collect them."}
      </Notice>
      <div className="mt-4">
        <LinkButton href={visitor === null ? "/login" : "/shop"} variant="secondary">
          {visitor === null ? "Sign in" : "Back to the shop"}
        </LinkButton>
      </div>
    </>
  );
}
