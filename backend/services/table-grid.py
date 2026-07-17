import cv2
import numpy as np
import sys
import json

def line_positions(mask, axis, min_coverage=0.3, merge_gap=20):
    # axis='row': sum each row of the mask; axis='col': sum each column.
    if axis == 'row':
        coverage = np.count_nonzero(mask, axis=1) / mask.shape[1]
    else:
        coverage = np.count_nonzero(mask, axis=0) / mask.shape[0]
    idx = np.where(coverage >= min_coverage)[0]
    if len(idx) == 0:
        return []
    # merge consecutive indices into one line position (their mean) - a real
    # border line, even a slightly thick/doubled one from JPEG artifacts, is
    # still a single visual line; merge_gap absorbs that without merging two
    # genuinely different lines together.
    groups = []
    run = [idx[0]]
    for v in idx[1:]:
        if v - run[-1] <= merge_gap:
            run.append(v)
        else:
            groups.append(int(np.mean(run)))
            run = [v]
    groups.append(int(np.mean(run)))
    return groups

def estimate_skew_angle(hor_lines):
    # Phone photos are rarely perfectly axis-aligned - even a 1-2 degree tilt
    # shifts a "horizontal" table line's y-position across the image width,
    # which breaks single-global-grid cell alignment (a cell crop straddles
    # two real rows). HoughLinesP finds line segments in the horizontal-line
    # mask; their average angle is the page's actual tilt, corrected before
    # any grid detection happens.
    lines = cv2.HoughLinesP(hor_lines, 1, np.pi / 360, threshold=200, minLineLength=hor_lines.shape[1] // 4, maxLineGap=20)
    if lines is None:
        return 0.0
    angles = []
    for line in lines:
        x1, y1, x2, y2 = np.array(line).reshape(-1)[:4]
        if x2 - x1 == 0:
            continue
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(angle) < 10:  # ignore near-vertical false matches
            angles.append(angle)
    if not angles:
        return 0.0
    return float(np.median(angles))

def extract_table_cells(image_path, out_json_path):
    img = cv2.imread(image_path)
    if img is None:
        print("FAILED TO LOAD IMAGE", file=sys.stderr)
        return

    img = cv2.resize(img, None, fx=3.5, fy=3.5, interpolation=cv2.INTER_LANCZOS4)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15)

    scale = 25
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (scale, 1))
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, scale))

    hor_lines_pre = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horizontal_kernel, iterations=2)
    skew_angle = estimate_skew_angle(hor_lines_pre)
    print("estimated skew angle:", skew_angle, file=sys.stderr)

    if abs(skew_angle) > 0.1:
        center = (img.shape[1] // 2, img.shape[0] // 2)
        rot_mat = cv2.getRotationMatrix2D(center, skew_angle, 1.0)
        img = cv2.warpAffine(img, rot_mat, (img.shape[1], img.shape[0]), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        thresh = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15)

    hor_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horizontal_kernel, iterations=2)
    ver_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, vertical_kernel, iterations=2)

    img_h, img_w = img.shape[0], img.shape[1]

    # Isolate the line-items table's own bordered rectangle before scanning for
    # the row/column grid. Without this, line-detection on the full page also
    # picks up unrelated bordered boxes lower down (CGST/SGST/IGST totals box,
    # stamp/signature box, Tel/Fax footer) as if they were extra table rows,
    # which wrecks short (1-2 row) tables. Fall back to full-image scanning
    # unchanged if no qualifying rectangle is found (safety net).
    table_rect = None
    combined = cv2.bitwise_or(hor_lines, ver_lines)
    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = img_h * img_w
    candidates = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        if w * h < img_area * 0.15:
            continue
        if h > w:  # table is always wider than tall; reject taller-than-wide boxes
            continue
        candidates.append((x, y, w, h))
    if candidates:
        # table always starts near the top of the photo, well above the
        # stamp/footer boxes near the bottom
        table_rect = min(candidates, key=lambda r: r[1])

    if table_rect:
        rx, ry, rw, rh = table_rect
        hor_region = hor_lines[ry:ry + rh, rx:rx + rw]
        ver_region = ver_lines[ry:ry + rh, rx:rx + rw]
        row_positions = [p + ry for p in line_positions(hor_region, 'row', min_coverage=0.2)]
        col_positions = [p + rx for p in line_positions(ver_region, 'col', min_coverage=0.1)]
    else:
        row_positions = line_positions(hor_lines, 'row', min_coverage=0.2)
        col_positions = line_positions(ver_lines, 'col', min_coverage=0.1)

    # The table's outermost border lines (left/top and right/bottom) are often
    # faint/absent right at the photo's own edge (lighting falloff, slight
    # crop, or rotation's BORDER_REPLICATE smearing that edge) - if the first/
    # last detected line isn't already near the edge, add the edge itself as
    # the missing boundary so that outer column/row isn't dropped. Bounds are
    # the isolated table rect's own edges when one was found, else the image.
    if table_rect:
        rx, ry, rw, rh = table_rect
        left_b, right_b, top_b, bottom_b = rx, rx + rw, ry, ry + rh
    else:
        left_b, right_b, top_b, bottom_b = 0, img_w, 0, img_h
    if col_positions:
        if col_positions[0] > left_b + (right_b - left_b) * 0.08:
            col_positions.insert(0, left_b + 5)
        if col_positions[-1] < right_b - (right_b - left_b) * 0.08:
            col_positions.append(right_b - 5)
    if row_positions:
        if row_positions[0] > top_b + (bottom_b - top_b) * 0.08:
            row_positions.insert(0, top_b + 5)
        if row_positions[-1] < bottom_b - (bottom_b - top_b) * 0.08:
            row_positions.append(bottom_b - 5)

    print("row_positions:", len(row_positions), "| col_positions:", len(col_positions), file=sys.stderr)
    if len(row_positions) < 3 or len(col_positions) < 3:
        with open(out_json_path, "w") as f:
            json.dump({"imageWidth": img_w, "imageHeight": img_h, "rows": []}, f)
        print("GRID FAILED - not enough lines", file=sys.stderr)
        return

    rows = []
    for r in range(len(row_positions) - 1):
        y = row_positions[r]
        h = row_positions[r + 1] - y
        if h < 15:
            continue
        row = []
        for c in range(len(col_positions) - 1):
            x = col_positions[c]
            w = col_positions[c + 1] - x
            if w < 15:
                continue
            row.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})
        if row:
            rows.append(row)

    rotated_path = out_json_path.replace(".json", "_rotated.png")
    cv2.imwrite(rotated_path, img)

    result = {
        "imageWidth": img_w,
        "imageHeight": img_h,
        "rotatedImagePath": rotated_path,
        "rows": [[{"x": c["x"], "y": c["y"], "w": c["w"], "h": c["h"]} for c in row] for row in rows],
    }
    with open(out_json_path, "w") as f:
        json.dump(result, f)
    print("rows found:", len(rows), "| row sizes:", [len(r) for r in rows], file=sys.stderr)

if __name__ == "__main__":
    extract_table_cells(sys.argv[1], sys.argv[2])
