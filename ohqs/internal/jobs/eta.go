package jobs

import "fmt"

func FunnyETA(remaining int, etaSec float64) (text string, beer bool) {
	beer = remaining >= 4 || etaSec >= 10*60
	switch {
	case remaining <= 0:
		return "nothing left. the beer was a maybe.", false
	case beer && remaining >= 6:
		return "a lot. go grab a beer — this is a compilation, not a coffee run.", true
	case beer:
		return "a lot. go grab a beer. maybe two if cargo is involved.", true
	case etaSec < 45:
		return "under a minute. don't get comfortable.", false
	case etaSec < 4*60:
		return fmt.Sprintf("about %d min. sip water, not a pint.", minutes(etaSec)), false
	default:
		return fmt.Sprintf("roughly %d min. stretch. beer still optional.", minutes(etaSec)), false
	}
}

func minutes(sec float64) int {
	n := int(sec/60 + 0.5)
	if n < 1 {
		return 1
	}
	return n
}

func estimateSec(remaining int, workMS []int64) float64 {
	if remaining <= 0 {
		return 0
	}
	if len(workMS) == 0 {
		return float64(remaining) * 75
	}
	var sum int64
	for _, ms := range workMS {
		sum += ms
	}
	avg := float64(sum) / float64(len(workMS)) / 1000
	if avg < 8 {
		avg = 8
	}
	return avg * float64(remaining)
}
