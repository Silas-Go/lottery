#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

#include "hdr_histogram.h"

// 镜像构建期主动投递曾导致 counts_index 断言的非法样本，确保边界返回 false，
// 同时确认合法样本仍能进入直方图；这不是运行时模拟指标。
int main(void)
{
    struct hdr_histogram* histogram = NULL;
    if (hdr_init(1, 1000, 3, &histogram) != 0)
    {
        return 1;
    }
    if (hdr_record_value(histogram, -1))
    {
        return 2;
    }
    if (hdr_record_value(histogram, 1001))
    {
        return 3;
    }
    if (!hdr_record_value(histogram, 1))
    {
        return 4;
    }
    free(histogram);
    return 0;
}
