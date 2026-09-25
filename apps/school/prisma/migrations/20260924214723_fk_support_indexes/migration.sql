-- CreateIndex
CREATE INDEX "automation_actions_ruleId_idx" ON "automation_actions"("ruleId");

-- CreateIndex
CREATE INDEX "automation_triggers_ruleId_idx" ON "automation_triggers"("ruleId");

-- CreateIndex
CREATE INDEX "cbt_exam_questions_questionId_idx" ON "cbt_exam_questions"("questionId");

-- CreateIndex
CREATE INDEX "cbt_exam_questions_sectionId_idx" ON "cbt_exam_questions"("sectionId");

-- CreateIndex
CREATE INDEX "cbt_exam_sections_examId_idx" ON "cbt_exam_sections"("examId");

-- CreateIndex
CREATE INDEX "cbt_exams_subjectId_idx" ON "cbt_exams"("subjectId");

-- CreateIndex
CREATE INDEX "cbt_topic_performance_topicId_idx" ON "cbt_topic_performance"("topicId");

-- CreateIndex
CREATE INDEX "class_subjects_sectionId_idx" ON "class_subjects"("sectionId");

-- CreateIndex
CREATE INDEX "class_subjects_subjectId_idx" ON "class_subjects"("subjectId");

-- CreateIndex
CREATE INDEX "enrollments_sectionId_idx" ON "enrollments"("sectionId");

-- CreateIndex
CREATE INDEX "enrollments_academicYearId_idx" ON "enrollments"("academicYearId");

-- CreateIndex
CREATE INDEX "exam_results_classSubjectId_termId_idx" ON "exam_results"("classSubjectId", "termId");

-- CreateIndex
CREATE INDEX "examinations_classId_idx" ON "examinations"("classId");

-- CreateIndex
CREATE INDEX "fee_structure_items_feeStructureId_idx" ON "fee_structure_items"("feeStructureId");

-- CreateIndex
CREATE INDEX "fee_structures_classId_idx" ON "fee_structures"("classId");

-- CreateIndex
CREATE INDEX "fee_structures_academicYearId_idx" ON "fee_structures"("academicYearId");

-- CreateIndex
CREATE INDEX "lesson_notes_subjectId_idx" ON "lesson_notes"("subjectId");

-- CreateIndex
CREATE INDEX "notification_deliveries_notificationId_idx" ON "notification_deliveries"("notificationId");

-- CreateIndex
CREATE INDEX "sections_formTeacherId_idx" ON "sections"("formTeacherId");

-- CreateIndex
CREATE INDEX "student_fees_termId_idx" ON "student_fees"("termId");

-- CreateIndex
CREATE INDEX "student_fees_feeStructureId_idx" ON "student_fees"("feeStructureId");

-- CreateIndex
CREATE INDEX "timetable_slots_teacherId_idx" ON "timetable_slots"("teacherId");

-- CreateIndex
CREATE INDEX "timetable_slots_classId_idx" ON "timetable_slots"("classId");
