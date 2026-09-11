INSERT INTO users (email, display_name, role, language)
VALUES
  ('warehouse@demo.local', 'Sandelys', 'WAREHOUSE', 'lt'),
  ('sales@demo.local', 'Pardavimai', 'SALES', 'lt'),
  ('admin@demo.local', 'Admin', 'ADMIN', 'lt');

INSERT INTO products (product_id, description, canonical_unit)
VALUES
  ('KAIN001', 'Medvilninė audinio juosta 200 cm', 'm'),
  ('KAIN002', 'Mikro pluošto užpilas', 'm'),
  ('KAIN003', 'Pamušalas „SoftLux“', 'm');

INSERT INTO stock_balances (product_id, on_hand, reserved, quality_hold)
SELECT id, '0', '0', '0' FROM products;

INSERT INTO product_identifier_aliases (product_id, alias)
SELECT id, product_id || '-OLD'
FROM products;

INSERT INTO source_documents (channel, external_id, filename, source_hash, file_version, payload_json)
VALUES
  ('SIMULATED_GMAIL', 'SUP-2026-09-01', 'pavyzdys-supplier.pdf', 'sha256-demo-001', 1, '{"source":"round2a-manual"}'),
  ('SIMULATED_DRIVE', 'CLI-2026-09-01', 'pavyzdys-invoice.pdf', 'sha256-demo-002', 1, '{"source":"round2a-manual"}');

INSERT INTO review_drafts (
  id, draft_type, status, source_document_id, source_ref, counterpart_name, document_number, issue_date, currency, total_amount
)
VALUES
  ('draft-supplier-example', 'SUPPLIER_RECEIPT', 'PENDING', 1, 'GMAIL://SUP-2026-09-01', 'Pavyzdys tiekėjas UAB', 'G-2026-09-01', '2026-09-01', 'EUR', '540'),
  ('draft-client-example', 'CLIENT_INVOICE', 'PENDING', 2, 'DRIVE://CLI-2026-09-01', 'Pavyzdys klientas AB', 'I-2026-09-01', '2026-09-01', 'EUR', '380');

INSERT INTO review_lines (
  draft_id,
  line_no,
  printed_product_id,
  printed_description,
  printed_quantity,
  printed_unit,
  printed_unit_price,
  printed_currency,
  source_evidence,
  extraction_confidence,
  interpretation,
  interpreted_product_id,
  interpreted_quantity,
  interpreted_unit,
  interpreted_unit_price,
  interpreted_currency,
  edited_product_id,
  edited_description,
  edited_quantity,
  edited_unit,
  edited_unit_price,
  edited_currency,
  matched_product_id,
  match_status,
  requires_human_action,
  is_stock_line
) VALUES
  ('draft-supplier-example', 1, 'KAIN001', 'Medvilninė audinio juosta', '100', 'm', '4.50', 'EUR', 'Table Row 1', 0.98, 'OK', 'KAIN001', '100', 'm', '4.50', 'EUR', 'KAIN001', 'Medvilninė audinio juosta 200 cm', '100', 'm', '4.50', 'EUR', 1, 'MATCHED', 0, 1),
  ('draft-supplier-example', 2, 'KAIN003', 'Pamušalo medžiaga', '20', 'm', '6.00', 'EUR', 'Table Row 2', 0.89, 'NeedsReview', 'KAIN003', '20', 'm', '6.00', 'EUR', NULL, NULL, '20', 'm', '6.00', 'EUR', NULL, 'UNRESOLVED', 1, 1),
  ('draft-client-example', 1, 'KAIN001', 'Medvilninė audinio juosta', '40', 'm', '12.00', 'EUR', 'Table Row 1', 0.96, 'OK', 'KAIN001', '40', 'm', '12.00', 'EUR', 'KAIN001', 'Medvilninė audinio juosta 200 cm', '40', 'm', '12.00', 'EUR', 1, 'MATCHED', 0, 1),
  ('draft-client-example', 2, 'KAIN999', 'Nežinomas audinys', '15', 'm', '8.00', 'EUR', 'Table Row 2', 0.42, 'UnknownProduct', 'KAIN999', '15', 'm', '8.00', 'EUR', NULL, NULL, '15', 'm', '8.00', 'EUR', NULL, 'UNRESOLVED', 1, 1);
