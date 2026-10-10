"use client";

import { ImagePlus, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { DialogActions, useToast } from "./overlay";
import { ProductPhoto } from "./shop-ui";
import { Button, CheckboxField, FormError, SelectField, TextAreaField, TextField } from "./ui";
import { api, errorMessage, fieldErrors } from "@/lib/api-client";
import { MAX_PRODUCT_IMAGES, PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, type Product } from "@/lib/contracts";
import { CURRENCY, parseMoney, toInputAmount } from "@/lib/money";

const SYMBOL =
  new Intl.NumberFormat("en", { style: "currency", currency: CURRENCY }).formatToParts(0).find((p) => p.type === "currency")
    ?.value ?? "";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Edit one product: details, whether it is on sale, its photos and its sizes.
 * Each section saves on its own, and `onChanged` hands back the fresh product.
 */
export function ProductEditor({ product, onChanged, onClose }: { product: Product; onChanged: (product: Product) => void; onClose: () => void }) {
  const toast = useToast();
  const picker = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState({
    name: product.name,
    category: product.category as string,
    description: product.description,
    price: toInputAmount(product.priceCents),
    memberPrice: toInputAmount(product.memberPriceCents),
  });
  const [active, setActive] = useState(product.active);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newSize, setNewSize] = useState({ size: "", stock: "0" });
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  /** Runs one change, reports what went wrong, and passes the updated product up. */
  async function run(key: string, request: () => Promise<Product>, done: string) {
    setBusy(key);
    setFormError(null);
    setErrors({});
    try {
      onChanged(await request());
      toast.success(done);
      return true;
    } catch (error) {
      setErrors(fieldErrors(error));
      setFormError(errorMessage(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  function saveDetails(e: FormEvent) {
    e.preventDefault();
    const priceCents = parseMoney(values.price);
    const memberPriceCents = values.memberPrice.trim() ? parseMoney(values.memberPrice) : priceCents;
    if (!priceCents || !memberPriceCents) {
      setErrors({ ...(priceCents ? {} : { priceCents: "Enter a price greater than zero" }), ...(memberPriceCents ? {} : { memberPriceCents: "Enter a price greater than zero" }) });
      return;
    }
    void run(
      "details",
      () =>
        api<Product>(`/api/products/${product.id}`, {
          method: "PATCH",
          body: { name: values.name, category: values.category, description: values.description, priceCents, memberPriceCents, active },
        }),
      "Product saved.",
    );
  }

  function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      setErrors({ image: "The image must be 5 MB or smaller" });
      return;
    }
    const form = new FormData();
    form.set("image", file);
    void run("image", () => api<Product>(`/api/products/${product.id}/images`, { method: "POST", form }), "Photo added.");
  }

  async function addSize(e: FormEvent) {
    e.preventDefault();
    const stock = Number(newSize.stock);
    if (!newSize.size.trim() || !Number.isInteger(stock) || stock < 0) {
      setErrors({ size: "Enter a size name and a whole number of stock" });
      return;
    }
    const added = await run(
      "size",
      () => api<Product>(`/api/products/${product.id}/variants`, { method: "POST", body: { size: newSize.size.trim(), stock } }),
      `Size ${newSize.size.trim()} added.`,
    );
    if (added) setNewSize({ size: "", stock: "0" });
  }

  return (
    <div className="space-y-6">
      <FormError message={formError} />

      <form onSubmit={saveDetails} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Product name" value={values.name} onChange={set("name")} error={errors.name} required />
          <SelectField label="Category" value={values.category} onChange={set("category")} error={errors.category}>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PRODUCT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
          <TextField label="Price" prefix={SYMBOL} inputMode="decimal" value={values.price} onChange={set("price")} error={errors.priceCents} required />
          <TextField label="Member price" prefix={SYMBOL} inputMode="decimal" value={values.memberPrice} onChange={set("memberPrice")} error={errors.memberPriceCents} optional hint="Blank = same as price" />
        </div>
        <TextAreaField label="Description" value={values.description} onChange={set("description")} error={errors.description} optional />
        <CheckboxField
          label="On sale in the shop"
          hint="Untick to hide it from the shop. Existing orders are not affected."
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        <p className="text-[0.8125rem] text-muted">Changing a price only affects new orders. Orders already placed keep the price they were placed at.</p>
        <Button type="submit" loading={busy === "details"}>
          Save details
        </Button>
      </form>

      <section aria-labelledby="product-photos" className="border-t border-line pt-5">
        <h3 id="product-photos" className="text-[0.9375rem] font-semibold">
          Photos ({product.images.length} of {MAX_PRODUCT_IMAGES})
        </h3>
        <p className="text-[0.8125rem] text-muted">The first photo is the one shown in the shop grid. JPEG, PNG or WebP, up to 5 MB.</p>
        <ul className="mt-3 flex flex-wrap gap-3">
          {product.images.map((image, i) => (
            <li key={image.id} className="relative">
              <ProductPhoto url={image.url} name={`${product.name}, photo ${i + 1}`} className="size-24 rounded-control border border-line" />
              <button
                type="button"
                disabled={busy !== null}
                aria-label={`Remove photo ${i + 1}`}
                onClick={() => run(`remove-${image.id}`, () => api<Product>(`/api/products/${product.id}/images/${image.id}`, { method: "DELETE" }), "Photo removed.")}
                className="absolute -right-2 -top-2 flex size-8 items-center justify-center rounded-full border border-line bg-surface text-bad shadow-card hover:bg-bad-soft"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {product.images.length < MAX_PRODUCT_IMAGES && (
            <li>
              <input
                ref={picker}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button variant="secondary" icon={ImagePlus} className="!h-24 w-24 flex-col !gap-1 !px-2 text-xs" loading={busy === "image"} onClick={() => picker.current?.click()}>
                Add photo
              </Button>
            </li>
          )}
        </ul>
        {errors.image && (
          <p role="alert" className="mt-2 text-[0.8125rem] text-bad">
            {errors.image}
          </p>
        )}
      </section>

      <section aria-labelledby="product-sizes" className="border-t border-line pt-5">
        <h3 id="product-sizes" className="text-[0.9375rem] font-semibold">
          Sizes
        </h3>
        <p className="text-[0.8125rem] text-muted">
          Current sizes: {product.variants.map((v) => `${v.size} (${v.stock})`).join(", ")}. Change stock counts on the product card.
        </p>
        <form onSubmit={addSize} noValidate className="mt-3 flex flex-wrap items-end gap-3">
          <TextField label="New size" value={newSize.size} onChange={(e) => setNewSize((s) => ({ ...s, size: e.target.value }))} error={errors.size} placeholder="XXL" className="w-32" />
          <TextField label="Stock" inputMode="numeric" value={newSize.stock} onChange={(e) => setNewSize((s) => ({ ...s, stock: e.target.value }))} error={errors.stock} className="w-24" />
          <Button type="submit" variant="secondary" icon={Plus} loading={busy === "size"}>
            Add size
          </Button>
        </form>
      </section>

      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </div>
  );
}
