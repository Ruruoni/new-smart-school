-- DropIndex
DROP INDEX "student_fees_invoiceId_key";

-- CreateIndex
CREATE INDEX "student_fees_invoiceId_idx" ON "student_fees"("invoiceId");
