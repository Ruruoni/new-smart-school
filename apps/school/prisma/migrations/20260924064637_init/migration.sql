-- CreateEnum
CREATE TYPE "SchoolStage" AS ENUM ('NURSERY', 'PRIMARY', 'JUNIOR_SECONDARY', 'SENIOR_SECONDARY');

-- CreateEnum
CREATE TYPE "RoomKind" AS ENUM ('CLASSROOM', 'LABORATORY', 'HALL', 'LIBRARY', 'ICT_LAB', 'OTHER');

-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'APPROVED', 'REJECTED', 'ENROLLED');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('OPEN', 'LOCKED');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PromotionDecision" AS ENUM ('PROMOTED', 'REPEATED', 'GRADUATED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ExamBody" AS ENUM ('INTERNAL', 'WAEC', 'NECO', 'JAMB', 'BECE');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MCQ_SINGLE', 'MCQ_MULTIPLE', 'TRUE_FALSE');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "ExamKind" AS ENUM ('SCHOOL', 'PRACTICE', 'MOCK');

-- CreateEnum
CREATE TYPE "CBTExamStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DiscountKind" AS ENUM ('DISCOUNT', 'SCHOLARSHIP');

-- CreateEnum
CREATE TYPE "DiscountValueType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceItemKind" AS ENUM ('CHARGE', 'DISCOUNT', 'SCHOLARSHIP');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'ONLINE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('CASH', 'RECEIVABLE', 'FEE_REVENUE', 'DISCOUNTS_GIVEN', 'SCHOLARSHIPS_GIVEN', 'STUDENT_CREDIT', 'EXPENSE');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('POSTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "AttendanceMethod" AS ENUM ('MANUAL', 'QR', 'RFID', 'FINGERPRINT');

-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('QR_SCANNER', 'RFID_READER', 'FINGERPRINT_READER', 'TABLET');

-- CreateEnum
CREATE TYPE "TimetableStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'WITHDRAWN', 'TRANSFERRED', 'GRADUATED');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'WITHDRAWN', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('ADMIN', 'TEACHER', 'STAFF', 'PARENT', 'STUDENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "FlagSource" AS ENUM ('LOCAL', 'CLOUD');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'GRACE', 'EXPIRED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "TriggerKind" AS ENUM ('EVENT', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('SUCCEEDED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'PREVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'ERROR', 'DUPLICATE', 'IMPORTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('STUDENT_LIST', 'CLASS_RESULTS', 'REPORT_CARD', 'ATTENDANCE', 'FINANCE_SUMMARY', 'DEBTORS', 'CBT_RESULTS', 'ADMISSIONS', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'XLSX', 'CSV');

-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('LOCAL', 'CLOUD');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncOperation" AS ENUM ('UPSERT', 'DELETE');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'ACKED', 'FAILED', 'CONFLICT', 'DEAD');

-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED_LOCAL', 'RESOLVED_CLOUD', 'RESOLVED_MERGED');

-- CreateEnum
CREATE TYPE "SyncDeviceKind" AS ENUM ('SERVER', 'KIOSK', 'TABLET');

-- CreateTable
CREATE TABLE "academic_years" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms" (
    "id" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "stage" "SchoolStage" NOT NULL,
    "nextClassId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "formTeacherId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "isCompulsory" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curricula" (
    "id" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "classLevel" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "topics" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "curricula_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_subjects" (
    "id" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "sectionId" UUID,
    "subjectId" UUID NOT NULL,
    "teacherId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RoomKind" NOT NULL DEFAULT 'CLASSROOM',
    "capacity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "roomId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_records" (
    "id" UUID NOT NULL,
    "applicationNumber" TEXT NOT NULL,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "stateOfOrigin" TEXT,
    "lga" TEXT,
    "religion" TEXT,
    "address" TEXT,
    "previousSchool" TEXT,
    "desiredClassId" UUID,
    "guardianName" TEXT NOT NULL,
    "guardianRelationship" TEXT NOT NULL,
    "guardianPhone" TEXT NOT NULL,
    "guardianEmail" TEXT,
    "guardianAddress" TEXT,
    "applicationFeeInvoiceId" UUID,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "approvedClassId" UUID,
    "accessCodeHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admission_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_documents" (
    "id" UUID NOT NULL,
    "admissionId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" UUID,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_schemes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "positionMethod" TEXT NOT NULL DEFAULT 'STANDARD_COMPETITION',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grading_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_rules" (
    "id" UUID NOT NULL,
    "schemeId" UUID NOT NULL,
    "grade" TEXT NOT NULL,
    "minScore" DECIMAL(5,2) NOT NULL,
    "maxScore" DECIMAL(5,2) NOT NULL,
    "remark" TEXT,
    "gradePoint" DECIMAL(4,2),
    "isPass" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "grade_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_types" (
    "id" UUID NOT NULL,
    "schemeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "maxScore" DECIMAL(5,2) NOT NULL,
    "isExam" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "assessment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessments" (
    "id" UUID NOT NULL,
    "classSubjectId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "maxScore" DECIMAL(5,2) NOT NULL,
    "heldOn" DATE,
    "status" "AssessmentStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_scores" (
    "id" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "score" DECIMAL(5,2),
    "isAbsent" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,
    "enteredById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "examinations" (
    "id" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "examinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_results" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "classSubjectId" UUID NOT NULL,
    "caTotal" DECIMAL(6,2) NOT NULL,
    "examScore" DECIMAL(6,2) NOT NULL,
    "total" DECIMAL(6,2) NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "grade" TEXT NOT NULL,
    "remark" TEXT,
    "subjectPosition" INTEGER,
    "classAverage" DECIMAL(5,2),
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "status" "ResultStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_cards" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "totalScore" DECIMAL(8,2) NOT NULL,
    "average" DECIMAL(5,2) NOT NULL,
    "position" INTEGER,
    "classSize" INTEGER,
    "subjectsCount" INTEGER NOT NULL,
    "cumulativeAverage" DECIMAL(5,2),
    "teacherRemark" TEXT,
    "principalRemark" TEXT,
    "attendanceSummary" JSONB NOT NULL DEFAULT '{}',
    "status" "ResultStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_records" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "fromEnrollmentId" UUID NOT NULL,
    "toClassId" UUID,
    "academicYearId" UUID NOT NULL,
    "decision" "PromotionDecision" NOT NULL,
    "basis" JSONB NOT NULL DEFAULT '{}',
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_topics" (
    "id" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "examBody" "ExamBody",

    CONSTRAINT "cbt_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_questions" (
    "id" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "topicId" UUID,
    "examBody" "ExamBody" NOT NULL DEFAULT 'INTERNAL',
    "year" INTEGER,
    "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
    "type" "QuestionType" NOT NULL DEFAULT 'MCQ_SINGLE',
    "stem" TEXT NOT NULL,
    "explanation" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cbt_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_question_options" (
    "id" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cbt_question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_exams" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ExamKind" NOT NULL DEFAULT 'SCHOOL',
    "examBody" "ExamBody" NOT NULL DEFAULT 'INTERNAL',
    "subjectId" UUID,
    "classIds" TEXT[],
    "durationMinutes" INTEGER NOT NULL,
    "passMark" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT false,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT false,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "showResultImmediately" BOOLEAN NOT NULL DEFAULT false,
    "status" "CBTExamStatus" NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cbt_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_exam_sections" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cbt_exam_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_exam_questions" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "sectionId" UUID,
    "questionId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "marks" DECIMAL(6,2) NOT NULL DEFAULT 1,

    CONSTRAINT "cbt_exam_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_attempts" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "questionOrder" JSONB NOT NULL DEFAULT '[]',
    "autosaveSeq" INTEGER NOT NULL DEFAULT 0,
    "lastSavedAt" TIMESTAMP(3),
    "clientSessionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cbt_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_answers" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "examQuestionId" UUID NOT NULL,
    "selectedOptionIds" TEXT[],
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "visited" BOOLEAN NOT NULL DEFAULT true,
    "clientSeq" INTEGER NOT NULL DEFAULT 0,
    "answeredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cbt_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_results" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "score" DECIMAL(8,2) NOT NULL,
    "totalMarks" DECIMAL(8,2) NOT NULL,
    "percentage" DECIMAL(5,2) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "correctCount" INTEGER NOT NULL,
    "wrongCount" INTEGER NOT NULL,
    "unansweredCount" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cbt_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbt_topic_performance" (
    "studentId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cbt_topic_performance_pkey" PRIMARY KEY ("studentId","topicId")
);

-- CreateTable
CREATE TABLE "fee_structures" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "academicYearId" UUID,
    "termId" UUID,
    "classId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structure_items" (
    "id" UUID NOT NULL,
    "feeStructureId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'TUITION',
    "amount" DECIMAL(14,2) NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fee_structure_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_fees" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "feeStructureId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "invoiceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_discounts" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "kind" "DiscountKind" NOT NULL,
    "valueType" "DiscountValueType" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "termId" UUID,
    "approvedById" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "studentId" UUID,
    "termId" UUID,
    "admissionRecordId" UUID,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "dueDate" DATE,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "InvoiceItemKind" NOT NULL DEFAULT 'CHARGE',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmount" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "studentId" UUID,
    "payerName" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'POSTED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "reversedAt" TIMESTAMP(3),
    "reversedById" UUID,
    "reversalReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_ledger" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "journalId" UUID NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account" "LedgerAccount" NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "memo" TEXT,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "studentId" UUID,
    "reversalOfJournalId" UUID,
    "createdById" UUID,

    CONSTRAINT "financial_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "vendor" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "status" "ExpenseStatus" NOT NULL DEFAULT 'POSTED',
    "approvedById" UUID,
    "recordedById" UUID,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_logs" (
    "id" UUID NOT NULL,
    "studentId" UUID,
    "staffUserId" UUID,
    "date" DATE NOT NULL,
    "session" TEXT NOT NULL DEFAULT 'DAY',
    "status" "AttendanceStatus" NOT NULL,
    "method" "AttendanceMethod" NOT NULL DEFAULT 'MANUAL',
    "checkedInAt" TIMESTAMP(3),
    "deviceId" UUID,
    "recordedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_devices" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DeviceKind" NOT NULL,
    "location" TEXT,
    "apiKeyHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetables" (
    "id" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TimetableStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "id" UUID NOT NULL,
    "timetableId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "periodIndex" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "classId" UUID NOT NULL,
    "sectionKey" TEXT NOT NULL DEFAULT '*',
    "sectionId" UUID,
    "subjectId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "roomId" UUID,
    "resourceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_notes" (
    "id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_note_versions" (
    "id" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_note_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_note_attachments" (
    "id" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_note_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "admissionNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "dateOfBirth" DATE,
    "stateOfOrigin" TEXT,
    "lga" TEXT,
    "nationality" TEXT NOT NULL DEFAULT 'Nigerian',
    "religion" TEXT,
    "bloodGroup" TEXT,
    "genotype" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "photoFileId" UUID,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "admittedOn" DATE,
    "admissionRecordId" UUID,
    "medicalNotes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_status_history" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "fromStatus" "StudentStatus",
    "toStatus" "StudentStatus" NOT NULL,
    "reason" TEXT,
    "changedById" UUID,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_documents" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parents" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "occupation" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian_relationships" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "parentId" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "canViewFinance" BOOLEAN NOT NULL DEFAULT true,
    "canViewResults" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardian_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teachers" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "staffNumber" TEXT NOT NULL,
    "qualification" TEXT,
    "specialization" TEXT,
    "employedOn" DATE,
    "phone" TEXT,
    "address" TEXT,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "staffNumber" TEXT NOT NULL,
    "department" TEXT,
    "position" TEXT,
    "employedOn" DATE,
    "phone" TEXT,
    "address" TEXT,
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "sectionId" UUID,
    "academicYearId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolledOn" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_installation" (
    "id" UUID NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "installationCode" TEXT NOT NULL,
    "schoolName" TEXT NOT NULL,
    "shortName" TEXT,
    "motto" TEXT,
    "logoFileId" UUID,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'Nigeria',
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "primaryColor" TEXT NOT NULL DEFAULT '#0f766e',
    "appVersion" TEXT NOT NULL DEFAULT '2.0.0',
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "cloudSecretEnc" TEXT,
    "cloudUrl" TEXT,
    "registeredAt" TIMESTAMP(3),
    "setupCompletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "userType" "UserType" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPrimaryAdmin" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isProtected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT '*',
    "scopeId" TEXT NOT NULL DEFAULT '*',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "module" TEXT,
    "description" TEXT,
    "source" "FlagSource" NOT NULL DEFAULT 'LOCAL',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module_settings" (
    "id" UUID NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "module_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "modules" TEXT[],
    "features" JSONB NOT NULL DEFAULT '{}',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "graceDays" INTEGER NOT NULL DEFAULT 30,
    "token" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "school_settings" (
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" UUID,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip" TEXT,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_assets" (
    "id" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "ownerType" TEXT,
    "ownerId" TEXT,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "file_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notificationId" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "provider" TEXT,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "providerRef" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL DEFAULT '{}',
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_triggers" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "kind" "TriggerKind" NOT NULL,
    "eventType" TEXT,
    "schedule" JSONB,
    "lastFiredAt" TIMESTAMP(3),

    CONSTRAINT "automation_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_actions" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "automation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_executions" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "eventId" UUID,
    "status" "ExecutionStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "log" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,

    CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "fileId" UUID NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "approvedById" UUID,
    "report" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB,
    "status" "ImportRowStatus" NOT NULL,
    "entityId" UUID,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_row_errors" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "field" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "import_row_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "dedupeKey" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "fileId" UUID,
    "requestedById" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_records" (
    "id" UUID NOT NULL,
    "kind" "BackupKind" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'RUNNING',
    "path" TEXT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "schemaVersion" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'school',
    "data" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "name" TEXT NOT NULL,
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "meta" JSONB,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "key" TEXT NOT NULL,
    "nextVal" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "sync_queue" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" "SyncOperation" NOT NULL,
    "payload" JSONB NOT NULL,
    "entityVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),

    CONSTRAINT "sync_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_conflicts" (
    "id" UUID NOT NULL,
    "queueId" UUID,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "localVersion" INTEGER NOT NULL,
    "cloudVersion" INTEGER NOT NULL,
    "localPayload" JSONB NOT NULL,
    "cloudPayload" JSONB NOT NULL,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "sync_devices" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SyncDeviceKind" NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_name_key" ON "academic_years"("name");

-- CreateIndex
CREATE INDEX "terms_isCurrent_idx" ON "terms"("isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "terms_academicYearId_sequence_key" ON "terms"("academicYearId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "classes_name_key" ON "classes"("name");

-- CreateIndex
CREATE INDEX "classes_level_idx" ON "classes"("level");

-- CreateIndex
CREATE UNIQUE INDEX "sections_classId_name_key" ON "sections"("classId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_code_key" ON "subjects"("code");

-- CreateIndex
CREATE UNIQUE INDEX "curricula_subjectId_classLevel_key" ON "curricula"("subjectId", "classLevel");

-- CreateIndex
CREATE INDEX "class_subjects_teacherId_idx" ON "class_subjects"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "class_subjects_classId_sectionId_subjectId_key" ON "class_subjects"("classId", "sectionId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_name_key" ON "rooms"("name");

-- CreateIndex
CREATE UNIQUE INDEX "resources_name_key" ON "resources"("name");

-- CreateIndex
CREATE UNIQUE INDEX "admission_records_applicationNumber_key" ON "admission_records"("applicationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "admission_records_applicationFeeInvoiceId_key" ON "admission_records"("applicationFeeInvoiceId");

-- CreateIndex
CREATE INDEX "admission_records_status_createdAt_idx" ON "admission_records"("status", "createdAt");

-- CreateIndex
CREATE INDEX "admission_records_guardianPhone_idx" ON "admission_records"("guardianPhone");

-- CreateIndex
CREATE INDEX "admission_documents_admissionId_idx" ON "admission_documents"("admissionId");

-- CreateIndex
CREATE UNIQUE INDEX "grading_schemes_name_key" ON "grading_schemes"("name");

-- CreateIndex
CREATE INDEX "grade_rules_schemeId_minScore_idx" ON "grade_rules"("schemeId", "minScore");

-- CreateIndex
CREATE UNIQUE INDEX "grade_rules_schemeId_grade_key" ON "grade_rules"("schemeId", "grade");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_types_schemeId_code_key" ON "assessment_types"("schemeId", "code");

-- CreateIndex
CREATE INDEX "assessments_termId_idx" ON "assessments"("termId");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_classSubjectId_termId_typeId_key" ON "assessments"("classSubjectId", "termId", "typeId");

-- CreateIndex
CREATE INDEX "assessment_scores_studentId_idx" ON "assessment_scores"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_scores_assessmentId_studentId_key" ON "assessment_scores"("assessmentId", "studentId");

-- CreateIndex
CREATE INDEX "examinations_termId_classId_idx" ON "examinations"("termId", "classId");

-- CreateIndex
CREATE INDEX "exam_results_termId_status_idx" ON "exam_results"("termId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_studentId_termId_classSubjectId_key" ON "exam_results"("studentId", "termId", "classSubjectId");

-- CreateIndex
CREATE INDEX "report_cards_termId_classId_status_idx" ON "report_cards"("termId", "classId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "report_cards_studentId_termId_key" ON "report_cards"("studentId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_records_studentId_academicYearId_key" ON "promotion_records"("studentId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "cbt_topics_subjectId_parentId_name_key" ON "cbt_topics"("subjectId", "parentId", "name");

-- CreateIndex
CREATE INDEX "cbt_questions_subjectId_examBody_difficulty_idx" ON "cbt_questions"("subjectId", "examBody", "difficulty");

-- CreateIndex
CREATE INDEX "cbt_questions_topicId_idx" ON "cbt_questions"("topicId");

-- CreateIndex
CREATE INDEX "cbt_questions_examBody_year_idx" ON "cbt_questions"("examBody", "year");

-- CreateIndex
CREATE UNIQUE INDEX "cbt_question_options_questionId_label_key" ON "cbt_question_options"("questionId", "label");

-- CreateIndex
CREATE INDEX "cbt_exams_status_opensAt_idx" ON "cbt_exams"("status", "opensAt");

-- CreateIndex
CREATE INDEX "cbt_exams_kind_examBody_idx" ON "cbt_exams"("kind", "examBody");

-- CreateIndex
CREATE INDEX "cbt_exam_questions_examId_sortOrder_idx" ON "cbt_exam_questions"("examId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "cbt_exam_questions_examId_questionId_key" ON "cbt_exam_questions"("examId", "questionId");

-- CreateIndex
CREATE INDEX "cbt_attempts_studentId_status_idx" ON "cbt_attempts"("studentId", "status");

-- CreateIndex
CREATE INDEX "cbt_attempts_status_deadlineAt_idx" ON "cbt_attempts"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "cbt_attempts_examId_studentId_attemptNumber_key" ON "cbt_attempts"("examId", "studentId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "cbt_answers_attemptId_examQuestionId_key" ON "cbt_answers"("attemptId", "examQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "cbt_results_attemptId_key" ON "cbt_results"("attemptId");

-- CreateIndex
CREATE INDEX "fee_structures_termId_classId_idx" ON "fee_structures"("termId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "student_fees_invoiceId_key" ON "student_fees"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "student_fees_studentId_feeStructureId_termId_key" ON "student_fees"("studentId", "feeStructureId", "termId");

-- CreateIndex
CREATE INDEX "student_discounts_studentId_idx" ON "student_discounts"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_studentId_status_idx" ON "invoices"("studentId", "status");

-- CreateIndex
CREATE INDEX "invoices_status_dueDate_idx" ON "invoices"("status", "dueDate");

-- CreateIndex
CREATE INDEX "invoices_termId_idx" ON "invoices"("termId");

-- CreateIndex
CREATE INDEX "invoice_items_invoiceId_idx" ON "invoice_items"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receiptNumber_key" ON "payments"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_studentId_receivedAt_idx" ON "payments"("studentId", "receivedAt");

-- CreateIndex
CREATE INDEX "payments_receivedAt_idx" ON "payments"("receivedAt");

-- CreateIndex
CREATE INDEX "payment_allocations_invoiceId_idx" ON "payment_allocations"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_paymentId_invoiceId_key" ON "payment_allocations"("paymentId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_ledger_seq_key" ON "financial_ledger"("seq");

-- CreateIndex
CREATE INDEX "financial_ledger_journalId_idx" ON "financial_ledger"("journalId");

-- CreateIndex
CREATE INDEX "financial_ledger_refType_refId_idx" ON "financial_ledger"("refType", "refId");

-- CreateIndex
CREATE INDEX "financial_ledger_studentId_entryDate_idx" ON "financial_ledger"("studentId", "entryDate");

-- CreateIndex
CREATE INDEX "financial_ledger_account_entryDate_idx" ON "financial_ledger"("account", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_number_key" ON "expenses"("number");

-- CreateIndex
CREATE INDEX "expenses_paidOn_idx" ON "expenses"("paidOn");

-- CreateIndex
CREATE INDEX "expenses_category_idx" ON "expenses"("category");

-- CreateIndex
CREATE INDEX "attendance_logs_date_status_idx" ON "attendance_logs"("date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_logs_studentId_date_session_key" ON "attendance_logs"("studentId", "date", "session");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_logs_staffUserId_date_session_key" ON "attendance_logs"("staffUserId", "date", "session");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_name_key" ON "attendance_devices"("name");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_apiKeyHash_key" ON "attendance_devices"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "timetables_termId_name_key" ON "timetables"("termId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_timetableId_dayOfWeek_periodIndex_teacherId_key" ON "timetable_slots"("timetableId", "dayOfWeek", "periodIndex", "teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_timetableId_dayOfWeek_periodIndex_roomId_key" ON "timetable_slots"("timetableId", "dayOfWeek", "periodIndex", "roomId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_timetableId_dayOfWeek_periodIndex_resourceI_key" ON "timetable_slots"("timetableId", "dayOfWeek", "periodIndex", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slots_timetableId_dayOfWeek_periodIndex_classId_s_key" ON "timetable_slots"("timetableId", "dayOfWeek", "periodIndex", "classId", "sectionKey");

-- CreateIndex
CREATE INDEX "lesson_notes_classId_subjectId_status_idx" ON "lesson_notes"("classId", "subjectId", "status");

-- CreateIndex
CREATE INDEX "lesson_notes_teacherId_idx" ON "lesson_notes"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_note_versions_noteId_versionNo_key" ON "lesson_note_versions"("noteId", "versionNo");

-- CreateIndex
CREATE INDEX "lesson_note_attachments_noteId_idx" ON "lesson_note_attachments"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX "students_userId_key" ON "students"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "students_admissionNumber_key" ON "students"("admissionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "students_admissionRecordId_key" ON "students"("admissionRecordId");

-- CreateIndex
CREATE INDEX "students_lastName_firstName_idx" ON "students"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "students_status_idx" ON "students"("status");

-- CreateIndex
CREATE INDEX "student_status_history_studentId_changedAt_idx" ON "student_status_history"("studentId", "changedAt");

-- CreateIndex
CREATE INDEX "student_documents_studentId_idx" ON "student_documents"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "parents_userId_key" ON "parents"("userId");

-- CreateIndex
CREATE INDEX "guardian_relationships_parentId_idx" ON "guardian_relationships"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "guardian_relationships_studentId_parentId_key" ON "guardian_relationships"("studentId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "teachers_userId_key" ON "teachers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "teachers_staffNumber_key" ON "teachers"("staffNumber");

-- CreateIndex
CREATE UNIQUE INDEX "staff_userId_key" ON "staff"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_staffNumber_key" ON "staff"("staffNumber");

-- CreateIndex
CREATE INDEX "enrollments_classId_sectionId_academicYearId_status_idx" ON "enrollments"("classId", "sectionId", "academicYearId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_studentId_academicYearId_key" ON "enrollments"("studentId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "school_installation_singleton_key" ON "school_installation"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "school_installation_installationCode_key" ON "school_installation"("installationCode");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_userType_status_idx" ON "users"("userType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "permissions_module_idx" ON "permissions"("module");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_userId_roleId_scopeType_scopeId_key" ON "user_roles"("userId", "roleId", "scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE UNIQUE INDEX "module_settings_moduleKey_key" ON "module_settings"("moduleKey");

-- CreateIndex
CREATE INDEX "licenses_isActive_idx" ON "licenses"("isActive");

-- CreateIndex
CREATE INDEX "school_settings_category_idx" ON "school_settings"("category");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_seq_key" ON "audit_logs"("seq");

-- CreateIndex
CREATE INDEX "audit_logs_module_action_idx" ON "audit_logs"("module", "action");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_occurredAt_idx" ON "audit_logs"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_occurredAt_idx" ON "audit_logs"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "file_assets_storageKey_key" ON "file_assets"("storageKey");

-- CreateIndex
CREATE INDEX "file_assets_ownerType_ownerId_idx" ON "file_assets"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "domain_events_seq_key" ON "domain_events"("seq");

-- CreateIndex
CREATE INDEX "domain_events_processedAt_nextAttemptAt_idx" ON "domain_events"("processedAt", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "domain_events_type_idx" ON "domain_events"("type");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_key_channel_key" ON "notification_templates"("key", "channel");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_nextAttemptAt_idx" ON "notification_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "announcements_publishedAt_idx" ON "announcements"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_name_key" ON "automation_rules"("name");

-- CreateIndex
CREATE INDEX "automation_triggers_kind_eventType_idx" ON "automation_triggers"("kind", "eventType");

-- CreateIndex
CREATE INDEX "automation_executions_ruleId_startedAt_idx" ON "automation_executions"("ruleId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_executions_ruleId_eventId_key" ON "automation_executions"("ruleId", "eventId");

-- CreateIndex
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_jobId_rowNumber_key" ON "import_rows"("jobId", "rowNumber");

-- CreateIndex
CREATE INDEX "import_row_errors_jobId_rowNumber_idx" ON "import_row_errors"("jobId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_dedupeKey_key" ON "background_jobs"("dedupeKey");

-- CreateIndex
CREATE INDEX "background_jobs_queue_status_runAt_idx" ON "background_jobs"("queue", "status", "runAt");

-- CreateIndex
CREATE INDEX "report_exports_requestedById_createdAt_idx" ON "report_exports"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "backup_records_startedAt_idx" ON "backup_records"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_snapshots_key_scope_key" ON "analytics_snapshots"("key", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "sync_queue_seq_key" ON "sync_queue"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "sync_queue_idempotencyKey_key" ON "sync_queue"("idempotencyKey");

-- CreateIndex
CREATE INDEX "sync_queue_status_nextAttemptAt_seq_idx" ON "sync_queue"("status", "nextAttemptAt", "seq");

-- CreateIndex
CREATE INDEX "sync_queue_entityType_entityId_idx" ON "sync_queue"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "sync_conflicts_status_idx" ON "sync_conflicts"("status");

-- CreateIndex
CREATE INDEX "sync_conflicts_entityType_entityId_idx" ON "sync_conflicts"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_devices_name_key" ON "sync_devices"("name");

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_nextClassId_fkey" FOREIGN KEY ("nextClassId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_formTeacherId_fkey" FOREIGN KEY ("formTeacherId") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curricula" ADD CONSTRAINT "curricula_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_records" ADD CONSTRAINT "admission_records_applicationFeeInvoiceId_fkey" FOREIGN KEY ("applicationFeeInvoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admission_documents" ADD CONSTRAINT "admission_documents_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "admission_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_rules" ADD CONSTRAINT "grade_rules_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "grading_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_types" ADD CONSTRAINT "assessment_types_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "grading_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_classSubjectId_fkey" FOREIGN KEY ("classSubjectId") REFERENCES "class_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "assessment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_classSubjectId_fkey" FOREIGN KEY ("classSubjectId") REFERENCES "class_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_records" ADD CONSTRAINT "promotion_records_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_records" ADD CONSTRAINT "promotion_records_fromEnrollmentId_fkey" FOREIGN KEY ("fromEnrollmentId") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_records" ADD CONSTRAINT "promotion_records_toClassId_fkey" FOREIGN KEY ("toClassId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_records" ADD CONSTRAINT "promotion_records_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_topics" ADD CONSTRAINT "cbt_topics_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_topics" ADD CONSTRAINT "cbt_topics_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "cbt_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_questions" ADD CONSTRAINT "cbt_questions_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_questions" ADD CONSTRAINT "cbt_questions_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "cbt_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_question_options" ADD CONSTRAINT "cbt_question_options_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "cbt_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_exams" ADD CONSTRAINT "cbt_exams_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_exam_sections" ADD CONSTRAINT "cbt_exam_sections_examId_fkey" FOREIGN KEY ("examId") REFERENCES "cbt_exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_exam_questions" ADD CONSTRAINT "cbt_exam_questions_examId_fkey" FOREIGN KEY ("examId") REFERENCES "cbt_exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_exam_questions" ADD CONSTRAINT "cbt_exam_questions_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "cbt_exam_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_exam_questions" ADD CONSTRAINT "cbt_exam_questions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "cbt_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_attempts" ADD CONSTRAINT "cbt_attempts_examId_fkey" FOREIGN KEY ("examId") REFERENCES "cbt_exams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_attempts" ADD CONSTRAINT "cbt_attempts_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_answers" ADD CONSTRAINT "cbt_answers_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "cbt_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_answers" ADD CONSTRAINT "cbt_answers_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "cbt_exam_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_results" ADD CONSTRAINT "cbt_results_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "cbt_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_topic_performance" ADD CONSTRAINT "cbt_topic_performance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cbt_topic_performance" ADD CONSTRAINT "cbt_topic_performance_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "cbt_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_feeStructureId_fkey" FOREIGN KEY ("feeStructureId") REFERENCES "fee_structures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fees" ADD CONSTRAINT "student_fees_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fees" ADD CONSTRAINT "student_fees_feeStructureId_fkey" FOREIGN KEY ("feeStructureId") REFERENCES "fee_structures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fees" ADD CONSTRAINT "student_fees_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fees" ADD CONSTRAINT "student_fees_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_discounts" ADD CONSTRAINT "student_discounts_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_logs" ADD CONSTRAINT "attendance_logs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "attendance_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_termId_fkey" FOREIGN KEY ("termId") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_timetableId_fkey" FOREIGN KEY ("timetableId") REFERENCES "timetables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_notes" ADD CONSTRAINT "lesson_notes_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_notes" ADD CONSTRAINT "lesson_notes_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_notes" ADD CONSTRAINT "lesson_notes_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_note_versions" ADD CONSTRAINT "lesson_note_versions_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "lesson_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_note_attachments" ADD CONSTRAINT "lesson_note_attachments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "lesson_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_admissionRecordId_fkey" FOREIGN KEY ("admissionRecordId") REFERENCES "admission_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_status_history" ADD CONSTRAINT "student_status_history_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parents" ADD CONSTRAINT "parents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_relationships" ADD CONSTRAINT "guardian_relationships_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_relationships" ADD CONSTRAINT "guardian_relationships_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_classId_fkey" FOREIGN KEY ("classId") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "domain_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_row_errors" ADD CONSTRAINT "import_row_errors_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflicts" ADD CONSTRAINT "sync_conflicts_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "sync_queue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════
-- DATABASE-LEVEL INTEGRITY RULES (not expressible in the Prisma schema).
-- These hold even if application code has a bug or someone uses psql directly.
-- ═════════════════════════════════════════════════════════════════════════

-- The installation row is a singleton.
ALTER TABLE "school_installation" ADD CONSTRAINT school_installation_singleton_chk CHECK ("singleton" = true);

-- At most ONE active Primary Admin per school.
CREATE UNIQUE INDEX users_single_primary_admin ON "users" ((true)) WHERE "isPrimaryAdmin" = true AND "deletedAt" IS NULL;

-- The Primary Admin can never be deleted, disabled, demoted or soft-deleted by accident.
-- A deliberate ownership transfer sets `smartschool.allow_primary_admin_change = 'on'` for its own transaction.
CREATE FUNCTION protect_primary_admin() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('smartschool.allow_primary_admin_change', true), 'off') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."isPrimaryAdmin" THEN
      RAISE EXCEPTION 'The Primary Admin account cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."isPrimaryAdmin" AND (
       NEW."isPrimaryAdmin" = false OR NEW."status" <> 'ACTIVE' OR NEW."deletedAt" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'The Primary Admin account cannot be disabled, demoted or deleted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER users_protect_primary_admin
  BEFORE UPDATE OR DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION protect_primary_admin();

-- Attendance belongs to exactly one person.
ALTER TABLE "attendance_logs" ADD CONSTRAINT attendance_one_subject_chk
  CHECK (("studentId" IS NOT NULL)::int + ("staffUserId" IS NOT NULL)::int = 1);

-- Append-only tables: audit log and financial ledger can never be edited or removed.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER financial_ledger_append_only
  BEFORE UPDATE OR DELETE ON "financial_ledger"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Ledger line shape: exactly one side is positive.
ALTER TABLE "financial_ledger" ADD CONSTRAINT ledger_line_shape_chk
  CHECK (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0));

-- Every journal must balance (checked at COMMIT so multi-line inserts in one transaction are fine).
CREATE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE d numeric; c numeric;
BEGIN
  SELECT coalesce(sum("debit"), 0), coalesce(sum("credit"), 0) INTO d, c
    FROM "financial_ledger" WHERE "journalId" = NEW."journalId";
  IF d <> c THEN
    RAISE EXCEPTION 'Unbalanced journal %: debits % <> credits %', NEW."journalId", d, c USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER financial_ledger_balanced
  AFTER INSERT ON "financial_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- Money sanity.
ALTER TABLE "payments"            ADD CONSTRAINT payments_amount_chk           CHECK ("amount" > 0);
ALTER TABLE "payment_allocations" ADD CONSTRAINT payment_alloc_amount_chk      CHECK ("amount" > 0);
ALTER TABLE "expenses"            ADD CONSTRAINT expenses_amount_chk           CHECK ("amount" > 0);
ALTER TABLE "invoices"            ADD CONSTRAINT invoices_amounts_chk          CHECK ("total" >= 0 AND "amountPaid" >= 0 AND "amountPaid" <= "total");
ALTER TABLE "fee_structure_items" ADD CONSTRAINT fee_item_amount_chk           CHECK ("amount" >= 0);

-- Academic sanity.
ALTER TABLE "grade_rules"        ADD CONSTRAINT grade_rule_range_chk           CHECK ("minScore" <= "maxScore");
ALTER TABLE "assessment_scores"  ADD CONSTRAINT assessment_score_nonneg_chk    CHECK ("score" IS NULL OR "score" >= 0);
ALTER TABLE "timetable_slots"    ADD CONSTRAINT timetable_day_chk              CHECK ("dayOfWeek" BETWEEN 1 AND 7);
ALTER TABLE "cbt_exams"          ADD CONSTRAINT cbt_duration_chk               CHECK ("durationMinutes" > 0);
ALTER TABLE "academic_years"     ADD CONSTRAINT academic_year_dates_chk        CHECK ("startDate" < "endDate");
ALTER TABLE "terms"              ADD CONSTRAINT term_dates_chk                 CHECK ("startDate" < "endDate");

-- Only one current academic year / term.
CREATE UNIQUE INDEX academic_years_single_current ON "academic_years" ((true)) WHERE "isCurrent" = true;
CREATE UNIQUE INDEX terms_single_current ON "terms" ((true)) WHERE "isCurrent" = true;

-- Only one default grading scheme.
CREATE UNIQUE INDEX grading_schemes_single_default ON "grading_schemes" ((true)) WHERE "isDefault" = true;

-- Only one ACTIVE license row.
CREATE UNIQUE INDEX licenses_single_active ON "licenses" ((true)) WHERE "isActive" = true;

-- One open (non-terminal) sync conflict per entity.
CREATE UNIQUE INDEX sync_conflicts_one_open ON "sync_conflicts" ("entityType", "entityId") WHERE "status" = 'OPEN';
